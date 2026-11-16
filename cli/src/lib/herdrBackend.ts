import type { TerminalBackend, TerminalBackendPrepared } from './terminalBackend.js'
import { HerdrApiClient, type HerdrApiResult, type HerdrEndpoint } from './herdrApiClient.js'
import {
  TERMINAL_ACTION_SUCCEEDED,
  terminalActionNotStarted,
  terminalActionPossiblyExecuted,
  terminalActionRejected,
  type HerdrRuntimeRef,
  type RuntimeValidation,
  type SubmitOptions,
  type TerminalActionResult,
  type TerminalBackendCapabilities,
  type TerminalCaptureOptions,
  type TerminalCreateRequest,
  type TerminalCreateResult,
  type TerminalInventoryResult,
  type TerminalLogicalKey,
  type TerminalPaneInfo,
  type TerminalPaneRead,
  type TerminalProcessExpectation,
  type TerminalReadResult,
} from './terminalTypes.js'
import { engineProcessMatchScore, enrichProcessRows, processRows } from './processTable.js'
import { terminalRouteKey } from './terminalRuntime.js'
import { parseHerdrWorkspaceList, type HerdrWorkspaceIndex } from './agentRail.js'

interface HerdrPaneInfo {
  pane_id: string
  terminal_id: string
  workspace_id?: string
  cwd?: string | null
  label?: string | null
  title?: string | null
  terminal_title_stripped?: string | null
  foreground_cwd?: string | null
}

interface HerdrSessionSnapshotResult {
  type: 'session_snapshot'
  snapshot: {
    version: string
    protocol: number
    panes: HerdrPaneInfo[]
  }
}

interface HerdrPaneProcessInfoResult {
  type: 'pane_process_info'
  process_info: {
    pane_id: string
    shell_pid?: number | null
    tty?: string | null
    foreground_processes?: Array<{ pid: number; name: string; cwd?: string | null; argv0?: string | null }>
  }
}

interface HerdrPaneReadResult {
  type: 'pane_read'
  read: { text: string }
}

interface HerdrPaneInfoResult {
  type: 'pane_info'
  pane: HerdrPaneInfo
}

interface HerdrWorkspaceListResult {
  type: 'workspace_list'
  workspaces: Array<Record<string, unknown>>
}

interface HerdrWorkspaceCreatedResult {
  type: 'workspace_created'
  workspace: { workspace_id: string }
  root_pane: HerdrPaneInfo
}

/** How long a read of Herdr's sidebar stands: a frame is projected from it without waiting, and a rename
 *  reaches every client within this long. */
const WORKSPACE_TTL_MS = 5_000

const HERDR_KEYS: Record<TerminalLogicalKey, string> = {
  enter: 'Enter',
  escape: 'Escape',
  tab: 'Tab',
  backtab: 'BackTab',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  home: 'Home',
  end: 'End',
  backspace: 'Backspace',
  delete: 'Delete',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  'ctrl-c': 'Ctrl+C',
  'ctrl-d': 'Ctrl+D',
  'ctrl-u': 'Ctrl+U',
  'ctrl-w': 'Ctrl+W',
  space: 'Space',
  '0': '0',
  '1': '1',
  '2': '2',
  '3': '3',
  '4': '4',
  '5': '5',
  '6': '6',
  '7': '7',
  '8': '8',
  '9': '9',
}

function actionResult(result: HerdrApiResult<unknown>): TerminalActionResult {
  if (result.ok) return TERMINAL_ACTION_SUCCEEDED
  if (result.dispatch === 'not_started') return terminalActionNotStarted(result.reason)
  if (result.dispatch === 'rejected') return terminalActionRejected(result.reason)
  return terminalActionPossiblyExecuted(result.reason)
}

function runtimeFor(endpoint: HerdrEndpoint, pane: HerdrPaneInfo): HerdrRuntimeRef {
  return {
    backend: 'herdr',
    endpointId: endpoint.endpointId,
    sessionName: endpoint.sessionName,
    terminalId: pane.terminal_id,
    paneId: pane.pane_id,
  }
}

function paneTitle(pane: HerdrPaneInfo): string | null {
  for (const candidate of [pane.label, pane.terminal_title_stripped, pane.title]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate
  }
  return null
}

/**
 * [argv] as one line a POSIX shell runs. Herdr's root pane is a real interactive shell, so the engine is
 * started the way a person would start it — `workspace.create` itself takes only a cwd and environment,
 * never an argv. Values are single-quoted; a quote closes, escapes and reopens.
 */
export function herdrShellCommand(argv: readonly string[]): string {
  return argv.map((word) => `'${word.replace(/'/g, `'\\''`)}'`).join(' ')
}

/** The first process a pane runs in the foreground that is not its own shell, if any. */
function foregroundOf(info: HerdrPaneProcessInfoResult['process_info']): { pid: number; name: string; cwd?: string | null } | null {
  const processes = info.foreground_processes ?? []
  return processes.find((process) => process.pid !== info.shell_pid) ?? processes[0] ?? null
}

export class HerdrBackend implements TerminalBackend<HerdrRuntimeRef> {
  readonly name = 'herdr' as const
  readonly instanceId: string
  readonly client: HerdrApiClient

  /** Herdr's own sidebar (workspace list), as read last: the labels and order the rail groups by. */
  private workspaces: HerdrWorkspaceIndex = new Map()
  /** When the sidebar was last read, or null when it never has been. */
  private workspaceReadAt: number | null = null
  private workspaceRefresh: Promise<void> | null = null

  constructor(
    readonly endpoint: HerdrEndpoint,
    client = new HerdrApiClient(endpoint),
  ) {
    this.instanceId = `herdr:${endpoint.endpointId}`
    this.client = client
  }

  async prepare({ ownedPanes }: { ownedPanes: ReadonlyMap<string, unknown> }): Promise<TerminalBackendPrepared> {
    const ping = await this.client.ping()
    if (!ping.ok) {
      console.error(`[herdr] ${this.endpoint.sessionName}: unavailable · ${ping.reason}`)
      return { state: 'unavailable', code: ping.code === 'protocol_mismatch' ? 'HERDR_INCOMPATIBLE' : 'HERDR_UNAVAILABLE', reason: ping.reason }
    }
    const inventory = await this.inventory()
    console.log(inventory.state === 'available'
      ? `[terminal] herdr: ${this.endpoint.sessionName} · ${inventory.roots.length} pane(s) visible · ${ownedPanes.size} owned`
      : `[terminal] herdr: ${this.endpoint.sessionName} · ${inventory.state} (${inventory.reason})`)
    return { state: 'ready' }
  }

  async capabilities(): Promise<TerminalBackendCapabilities> {
    return { sessionEnv: true }
  }

  async create(request: TerminalCreateRequest): Promise<TerminalCreateResult<HerdrRuntimeRef>> {
    if (request.expectedHeldToken) return terminalActionNotStarted('a waiting pane cannot be adopted on Herdr')
    if (request.current?.() === false) return terminalActionNotStarted('The harness changed before pane dispatch')
    request.onDispatch?.()
    // Herdr's sidebar is the person's own workspace list, so the workspace it makes carries the agent's own
    // folder and name: the pane's login shell still starts where the caller asked (`cwd`), but the workspace
    // is grouped and labelled as the work it is for.
    const workspaceCwd = request.workspaceCwd ?? request.cwd
    const workspaceLabel = request.workspaceLabel ?? request.label
    const created = await this.client.request<HerdrWorkspaceCreatedResult>('workspace.create', {
      ...(workspaceCwd ? { cwd: workspaceCwd } : {}),
      focus: false,
      ...(workspaceLabel ? { label: workspaceLabel } : {}),
      env: request.env ?? {},
    }, { mutation: 'other' })
    if (!created.ok) {
      if (created.dispatch === 'not_started') return terminalActionNotStarted(created.reason)
      if (created.dispatch === 'rejected') return terminalActionRejected(created.reason)
      return terminalActionPossiblyExecuted(created.reason)
    }
    if (created.result.type !== 'workspace_created'
      || typeof created.result.root_pane?.pane_id !== 'string'
      || typeof created.result.root_pane?.terminal_id !== 'string') {
      return terminalActionPossiblyExecuted('Herdr created a workspace without returning its root pane')
    }
    const runtime = runtimeFor(this.endpoint, created.result.root_pane)
    if (!request.command?.length) return { state: 'succeeded', dispatch: 'executed', runtime }
    // The workspace's root shell may still be coming up. `pane.send_input` queues at the pane's PTY, so
    // the launch line waits for the shell exactly as a person's typing would; a rejected send is the
    // one state in which nothing ran.
    const launched = await this.launch(runtime, request.command)
    if (launched.state === 'succeeded' || launched.state === 'unknown') return { state: 'succeeded', dispatch: 'executed', runtime }
    // The workspace exists even when its launch line did not land: say so, and let the pane be closed by
    // the caller's cleanup rather than pretending a pane was never created.
    return { state: 'unknown', dispatch: 'possibly_executed', reason: `Herdr made ${terminalRouteKey(runtime)} but the engine launch was refused: ${launched.reason}` }
  }

  private async launch(runtime: HerdrRuntimeRef, command: readonly string[]): Promise<TerminalActionResult> {
    return actionResult(await this.client.request('pane.send_input', {
      pane_id: runtime.paneId,
      text: herdrShellCommand(command),
      keys: ['Enter'],
    }, { mutation: 'single_enqueue' }))
  }

  async kill(runtime: HerdrRuntimeRef, current?: () => boolean): Promise<TerminalActionResult> {
    if (!this.owns(runtime)) return terminalActionNotStarted('Herdr runtime belongs to another configured endpoint')
    const info = await this.client.request<HerdrPaneInfoResult>('pane.get', { pane_id: runtime.paneId })
    if (!info.ok) {
      // A pane Herdr no longer has is already killed.
      return info.code === 'pane_not_found' ? TERMINAL_ACTION_SUCCEEDED : terminalActionNotStarted(info.reason)
    }
    if (info.result.type !== 'pane_info' || info.result.pane?.terminal_id !== runtime.terminalId) {
      return terminalActionNotStarted('Herdr terminal identity changed under pane route')
    }
    if (current?.() === false) return terminalActionNotStarted('The harness changed before pane close')
    // Close the pane, not its workspace: a person may have moved it beside panes of their own.
    return actionResult(await this.client.request('pane.close', { pane_id: runtime.paneId }, { mutation: 'other' }))
  }

  /** Herdr's workspaces by id, as last read. Synchronous on purpose: a frame is projected without waiting on
   *  Herdr, and a client groups on what the last read said (agentRail.ts). */
  workspaceIndex(): HerdrWorkspaceIndex { return this.workspaces }

  /** Read `workspace.list` again — at most once per WORKSPACE_TTL_MS, and at most once at a time — so a
   *  workspace the person renames or closes reaches the rail. Never rejects, and never throws into a frame. */
  refreshWorkspaces(now = Date.now()): Promise<void> {
    if (this.workspaceRefresh) return this.workspaceRefresh
    if (this.workspaceReadAt !== null && now - this.workspaceReadAt < WORKSPACE_TTL_MS) return Promise.resolve()
    const refresh = (async () => {
      try {
        const answer = await this.client.request<HerdrWorkspaceListResult>('workspace.list', {})
        if (!answer.ok) return
        if (answer.result.type !== 'workspace_list') return
        const list = parseHerdrWorkspaceList({ result: answer.result })
        this.workspaces = new Map(list.map((workspace) => [workspace.id, workspace]))
        this.workspaceReadAt = Date.now()
      } catch { /* Herdr went away: the labels it gave last stand. */ }
      finally { this.workspaceRefresh = null }
    })()
    this.workspaceRefresh = refresh
    return refresh
  }

  async titles(): Promise<TerminalReadResult<Map<string, string>>> {
    void this.refreshWorkspaces()
    const snapshot = await this.client.request<HerdrSessionSnapshotResult>('session.snapshot', {})
    if (!snapshot.ok) return { state: 'failed', reason: snapshot.reason }
    if (snapshot.result.type !== 'session_snapshot' || !Array.isArray(snapshot.result.snapshot?.panes)) {
      return { state: 'failed', reason: 'Herdr session snapshot has an incompatible shape' }
    }
    const titles = new Map<string, string>()
    for (const pane of snapshot.result.snapshot.panes) {
      if (!pane || typeof pane.pane_id !== 'string' || typeof pane.terminal_id !== 'string') continue
      const title = paneTitle(pane)
      if (title) titles.set(terminalRouteKey(runtimeFor(this.endpoint, pane)), title)
    }
    return { state: 'succeeded', value: titles }
  }

  private owns(runtime: HerdrRuntimeRef): boolean {
    return runtime.endpointId === this.endpoint.endpointId && runtime.sessionName === this.endpoint.sessionName
  }

  async inventory(): Promise<TerminalInventoryResult> {
    void this.refreshWorkspaces()
    const ping = await this.client.ping()
    if (!ping.ok) {
      return ping.code === 'protocol_mismatch'
        ? { state: 'incompatible', reason: ping.reason }
        : { state: 'unavailable', reason: ping.reason }
    }
    const snapshot = await this.client.request<HerdrSessionSnapshotResult>('session.snapshot', {})
    if (!snapshot.ok) return { state: 'unavailable', reason: snapshot.reason }
    if (snapshot.result.type !== 'session_snapshot' || !Array.isArray(snapshot.result.snapshot?.panes)) {
      return { state: 'incompatible', reason: 'Herdr session snapshot has an incompatible shape' }
    }
    const roots = await Promise.all(snapshot.result.snapshot.panes.map(async (pane) => {
      if (!pane || typeof pane.pane_id !== 'string' || typeof pane.terminal_id !== 'string') return null
      const info = await this.client.request<HerdrPaneProcessInfoResult>('pane.process_info', { pane_id: pane.pane_id })
      if (!info.ok
        || info.result.type !== 'pane_process_info'
        || !Number.isSafeInteger(info.result.process_info?.shell_pid)
        || info.result.process_info.shell_pid! <= 0) return null
      return {
        runtime: runtimeFor(this.endpoint, pane),
        rootPid: info.result.process_info.shell_pid!,
        cwd: typeof pane.cwd === 'string' ? pane.cwd : '',
      }
    }))
    if (roots.some((root) => root === null)) {
      return { state: 'unavailable', reason: 'Herdr pane process inventory failed' }
    }
    return { state: 'available', roots: roots.filter((root) => root !== null) }
  }

  async resolveRuntimeHint(paneId: string): Promise<TerminalReadResult<HerdrRuntimeRef>> {
    const info = await this.client.request<HerdrPaneInfoResult>('pane.get', { pane_id: paneId })
    if (!info.ok || info.result.type !== 'pane_info' || typeof info.result.pane?.terminal_id !== 'string') {
      return { state: 'failed', reason: info.ok ? 'Herdr pane response is incompatible' : info.reason }
    }
    return { state: 'succeeded', value: runtimeFor(this.endpoint, info.result.pane) }
  }

  async validate(runtime: HerdrRuntimeRef, _expected: TerminalProcessExpectation): Promise<RuntimeValidation> {
    if (!this.owns(runtime)) return { state: 'gone', reason: 'Herdr runtime belongs to another configured endpoint' }
    const resolved = await this.resolveRuntimeHint(runtime.paneId)
    if (resolved.state === 'failed') return { state: 'unknown', reason: resolved.reason }
    if (resolved.value.terminalId !== runtime.terminalId) {
      return { state: 'gone', reason: 'Herdr terminal identity changed under pane route' }
    }
    if (!_expected.processIdentity) return { state: 'alive' }
    const [info, rows] = await Promise.all([
      this.client.request<HerdrPaneProcessInfoResult>('pane.process_info', { pane_id: runtime.paneId }),
      processRows(),
    ])
    if (!info.ok || !rows || info.result.type !== 'pane_process_info'
      || !Number.isSafeInteger(info.result.process_info?.shell_pid)) {
      return { state: 'unknown', reason: 'Herdr process identity could not be verified' }
    }
    const enrichedRows = await enrichProcessRows(rows, new Set([_expected.processIdentity.pid]))
    const expected = enrichedRows.find((row) => row.pid === _expected.processIdentity!.pid)
    if (!expected || expected.startMarker !== _expected.processIdentity.startMarker) {
      return { state: 'gone', reason: 'Herdr engine process identity changed' }
    }
    if (engineProcessMatchScore(expected, _expected.engine) <= 0) {
      return { state: 'gone', reason: 'Herdr process no longer matches the registered engine' }
    }
    const byPid = new Map(enrichedRows.map((row) => [row.pid, row]))
    const rootPid = info.result.process_info.shell_pid!
    let pid = expected.pid
    const visited = new Set<number>()
    while (pid > 0 && !visited.has(pid)) {
      if (pid === rootPid) return { state: 'alive' }
      visited.add(pid)
      pid = byPid.get(pid)?.parentPid ?? 0
    }
    return { state: 'gone', reason: 'Herdr engine process is no longer under the terminal root' }
  }

  async capture(runtime: HerdrRuntimeRef, options: TerminalCaptureOptions = {}): Promise<TerminalReadResult<string>> {
    if (!this.owns(runtime)) return { state: 'failed', reason: 'Herdr runtime belongs to another configured endpoint' }
    const result = await this.client.request<HerdrPaneReadResult>('pane.read', {
      pane_id: runtime.paneId,
      source: options.mode ?? 'recent_unwrapped',
      lines: Math.max(20, Math.min(300, Math.floor(options.historyLines ?? 100))),
      format: options.ansi === false ? 'text' : 'ansi',
      strip_ansi: options.ansi === false,
    })
    if (!result.ok) return { state: 'failed', reason: result.reason }
    if (result.result.type !== 'pane_read' || typeof result.result.read?.text !== 'string') {
      return { state: 'failed', reason: 'Herdr pane capture has an incompatible shape' }
    }
    return { state: 'succeeded', value: result.result.read.text }
  }

  async typeLiteral(runtime: HerdrRuntimeRef, text: string): Promise<TerminalActionResult> {
    if (!this.owns(runtime)) return terminalActionNotStarted('Herdr runtime belongs to another configured endpoint')
    return actionResult(await this.client.request('pane.send_text', {
      pane_id: runtime.paneId,
      text,
    }, { mutation: 'single_enqueue' }))
  }

  async submitText(runtime: HerdrRuntimeRef, text: string, options?: SubmitOptions): Promise<TerminalActionResult> {
    if (!this.owns(runtime)) return terminalActionNotStarted('Herdr runtime belongs to another configured endpoint')
    if (options?.allowed?.() === false) return terminalActionNotStarted('The harness changed before submit')
    return actionResult(await this.client.request('pane.send_input', {
      pane_id: runtime.paneId,
      text: text.replace(/[\r\n]+$/, ''),
      keys: ['Enter'],
    }, { mutation: 'single_enqueue' }))
  }

  async sendKey(runtime: HerdrRuntimeRef, key: TerminalLogicalKey): Promise<TerminalActionResult> {
    if (!this.owns(runtime)) return terminalActionNotStarted('Herdr runtime belongs to another configured endpoint')
    return actionResult(await this.client.request('pane.send_keys', {
      pane_id: runtime.paneId,
      keys: [HERDR_KEYS[key]],
    }, { mutation: 'single_key' }))
  }

  /** Raw bytes from a terminal stream, as the keys a person would type. Printable runs go as text; the
   *  control bytes people actually lean on go as named keys. A byte with no key name is refused rather
   *  than dropped, so a caller knows that keystroke did not land. */
  async writeInput(runtime: HerdrRuntimeRef, bytes: Uint8Array): Promise<TerminalActionResult> {
    if (!this.owns(runtime)) return terminalActionNotStarted('Herdr runtime belongs to another configured endpoint')
    const text = Buffer.from(bytes).toString('utf8')
    const keys: string[] = []
    let literal = ''
    const flush = async (): Promise<TerminalActionResult | null> => {
      if (!literal) return null
      const pending = literal
      literal = ''
      return actionResult(await this.client.request('pane.send_text', { pane_id: runtime.paneId, text: pending }, { mutation: 'single_enqueue' }))
    }
    for (const char of text) {
      const named = char === '\r' || char === '\n' ? 'Enter'
        : char === '\u0003' ? 'Ctrl+C'
          : char === '\u0004' ? 'Ctrl+D'
            : char === '\u0015' ? 'Ctrl+U'
              : char === '\u0017' ? 'Ctrl+W'
                : char === '\t' ? 'Tab'
                  : char === '\u007f' ? 'Backspace'
                    : char === '\u001b' ? 'Escape'
                      : null
      if (named) {
        const sent = await flush()
        if (sent && sent.state !== 'succeeded') return sent
        keys.push(named)
        continue
      }
      if (char < ' ' && char !== '\n') return terminalActionNotStarted(`Herdr has no key for byte ${char.charCodeAt(0)}`)
      literal += char
    }
    const sent = await flush()
    if (sent && sent.state !== 'succeeded') return sent
    if (keys.length) {
      const result = await actionResult(await this.client.request('pane.send_keys', { pane_id: runtime.paneId, keys }, { mutation: 'single_key' }))
      if (result.state !== 'succeeded') return result
    }
    return TERMINAL_ACTION_SUCCEEDED
  }

  async pasteInput(runtime: HerdrRuntimeRef, text: string): Promise<TerminalActionResult> {
    if (!this.owns(runtime)) return terminalActionNotStarted('Herdr runtime belongs to another configured endpoint')
    return actionResult(await this.client.request('pane.send_text', { pane_id: runtime.paneId, text }, { mutation: 'single_enqueue' }))
  }

  async setTitle(runtime: HerdrRuntimeRef, title: string): Promise<TerminalActionResult> {
    if (!this.owns(runtime)) return terminalActionNotStarted('Herdr runtime belongs to another configured endpoint')
    return actionResult(await this.client.request('pane.rename', {
      pane_id: runtime.paneId,
      label: title.slice(0, 200),
    }, { mutation: 'other' }))
  }

  async notify(runtime: HerdrRuntimeRef, title: string, body: string): Promise<TerminalActionResult> {
    if (!this.owns(runtime)) return terminalActionNotStarted('Herdr runtime belongs to another configured endpoint')
    return actionResult(await this.client.request('notification.show', {
      title: title.slice(0, 200),
      body: body.slice(0, 1_000),
      sound: 'none',
    }, { mutation: 'other' }))
  }

  /** A Herdr pane keeps its shell after the engine exits, so the pane is already "held". */
  async releaseHold(_runtime: HerdrRuntimeRef, _current?: () => boolean): Promise<void> {}

  async paneState(runtime: HerdrRuntimeRef): Promise<TerminalPaneRead> {
    if (!this.owns(runtime)) return 'unknown'
    const info = await this.client.request<HerdrPaneInfoResult>('pane.get', { pane_id: runtime.paneId })
    if (!info.ok) return info.code === 'pane_not_found' ? 'gone' : 'unknown'
    if (info.result.type !== 'pane_info' || info.result.pane.terminal_id !== runtime.terminalId) return 'gone'
    const process = await this.client.request<HerdrPaneProcessInfoResult>('pane.process_info', { pane_id: runtime.paneId })
    if (!process.ok || process.result.type !== 'pane_process_info') {
      return { dead: false, exitStatus: null, command: '', engineExit: null }
    }
    const foreground = foregroundOf(process.result.process_info)
    // Herdr keeps the shell and gives no exit status for the foreground program. Reporting the pane as
    // alive is the safe answer: the reconciler proves an engine gone from the process table, by identity.
    return { dead: false, exitStatus: null, command: foreground?.name ?? '', engineExit: null }
  }

  async paneInfo(runtime: HerdrRuntimeRef): Promise<TerminalPaneInfo | null> {
    if (!this.owns(runtime)) return null
    const info = await this.client.request<HerdrPaneProcessInfoResult>('pane.process_info', { pane_id: runtime.paneId })
    if (!info.ok || info.result.type !== 'pane_process_info') return null
    const foreground = foregroundOf(info.result.process_info)
    if (!foreground) return null
    return {
      command: foreground.name,
      path: foreground.cwd ?? '',
      pid: foreground.pid,
      tty: info.result.process_info.tty ?? '',
    }
  }

  async rootProcess(runtime: HerdrRuntimeRef): Promise<number | 'missing' | null> {
    if (!this.owns(runtime)) return null
    const info = await this.client.request<HerdrPaneProcessInfoResult>('pane.process_info', { pane_id: runtime.paneId })
    if (!info.ok) return info.code === 'pane_not_found' ? 'missing' : null
    if (info.result.type !== 'pane_process_info') return null
    const pid = info.result.process_info.shell_pid
    return Number.isSafeInteger(pid) && pid! > 0 ? pid! : 'missing'
  }
}
