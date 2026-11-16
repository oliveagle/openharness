import { basename } from 'node:path'
/**
 * The machine's rail: the two levels every client draws, and nothing more.
 *
 * Herdr's sidebar is a workspace list with panes under each workspace, and a person who runs agents from
 * the shell already reads their work that way. The web page and the phone draw their own rails — a tree,
 * a drawer, a tab strip — but they must group the SAME two things: the workspace an agent belongs to,
 * and the agent itself (its pane). This module is the one place that says which workspace an agent is
 * in, so no client has to guess it from a folder path, and none of them disagree.
 *
 * The workspace is Herdr's own when the agent runs in a Herdr pane: its workspace id is the pane id's
 * prefix (`w7:p2` is in `w7`), and the label and sidebar order come from `workspace.list`, which
 * HerdrBackend caches (`workspaceIndex`). Everything else — tmux, the PTY host, a stopped agent whose
 * pane is gone — is grouped by the folder its work is in, which is the same grouping a person would
 * make by hand.
 *
 * The pane level is not in here: it is already on the frame (`terminal.runtimes[].paneId`), which is
 * what a client opens, types into and reads. A rail groups; a runtime opens.
 */
import { HERDR_PANE, terminalRouteKey } from './terminalRuntime.js'
import { projectDisplayName, type RegisteredSession } from './registry.js'
import type { HerdrRuntimeRef, TerminalRuntimeRef } from './terminalTypes.js'

/** Where an agent sits in the machine's rail: the workspace level, and how to name and order it. */
export interface AgentRailRef {
  /** `herdr` when the agent runs in a Herdr pane; `folder` when it is grouped by the folder it works in. */
  kind: 'herdr' | 'folder'
  /** The workspace id (`w7`), or the folder's absolute path for a `folder` workspace. Unique per machine. */
  id: string
  /** What the sidebar calls it: Herdr's workspace label, or the folder's own name. Null until Herdr is read. */
  label: string | null
  /** Where the workspace sits in Herdr's sidebar, ascending. Null for a folder workspace, or before Herdr answers. */
  order: number | null
  /** The folder the workspace is about, when one is known. */
  cwd: string | null
}

/** One workspace of Herdr's sidebar, as `workspace.list` gives it. */
export interface HerdrWorkspace {
  id: string
  label: string | null
  order: number | null
  paneCount: number
  focused: boolean
  agentStatus: string | null
}

/** Herdr's workspaces by id, for one endpoint: what the rail reads its labels and order from. */
export type HerdrWorkspaceIndex = ReadonlyMap<string, HerdrWorkspace>

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value : null
const integer = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null

/**
 * `workspace.list` as Herdr gives it: `{ result: { type: 'workspace_list', workspaces: [...] } }`.
 *
 * The ids are base 36 (`w1`..`w9`, `wA`, `wZ`): a digits-only reading stops working at the tenth
 * workspace, which is the same base-36 trap the pane ids had (`terminalRuntime.ts` HERDR_PANE).
 */
export function parseHerdrWorkspaceList(result: unknown): HerdrWorkspace[] {
  const body = record(record(result)?.result) ?? record(result)
  if (!body || body.type !== 'workspace_list' || !Array.isArray(body.workspaces)) return []
  const workspaces: HerdrWorkspace[] = []
  for (const entry of body.workspaces) {
    const each = record(entry)
    const id = text(each?.workspace_id)
    if (!each || !id) continue
    workspaces.push({
      id,
      label: text(each.label),
      order: integer(each.number),
      paneCount: integer(each.pane_count) ?? 0,
      focused: each.focused === true,
      agentStatus: text(each.agent_status),
    })
  }
  return workspaces.sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER))
}

/** The workspace a Herdr pane id names: `w7:p2` → `w7`. Null for an id Herdr would not have made. */
export function herdrPaneWorkspaceId(paneId: string): string | null {
  if (!HERDR_PANE.test(paneId)) return null
  return paneId.slice(0, paneId.indexOf(':'))
}

/** The agent's own Herdr pane, when it has one: the primary runtime if it is Herdr's, else its first Herdr runtime. */
export function herdrRuntimeOf(s: RegisteredSession): HerdrRuntimeRef | null {
  const runtimes = s.runtimes as readonly TerminalRuntimeRef[]
  const primary = runtimes.find((each) => each.backend === 'herdr' && terminalRouteKey(each) === s.primaryRuntimeKey)
  if (primary?.backend === 'herdr') return primary
  const any = runtimes.find((each) => each.backend === 'herdr')
  return any?.backend === 'herdr' ? any : null
}

/**
 * The workspace level for [s]. [workspaces] reads the index for a Herdr endpoint; without it (a daemon
 * whose Herdr has not answered yet, or a test with no Herdr at all) a Herdr agent still gets its
 * workspace id — a client can group on that — and only the label and order wait.
 *
 * A trailing separator is trimmed from a folder id so `/work/x` and `/work/x/` are one workspace.
 */
export function railRefFor(
  s: RegisteredSession,
  workspaces?: ((endpointId: string) => HerdrWorkspaceIndex | null) | null,
): AgentRailRef {
  const herdr = herdrRuntimeOf(s)
  const herdrWorkspace = herdr && herdrPaneWorkspaceId(herdr.paneId)
  if (herdr && herdrWorkspace) {
    const found = workspaces?.(herdr.endpointId)?.get(herdrWorkspace) ?? null
    return {
      kind: 'herdr',
      id: herdrWorkspace,
      label: found?.label ?? null,
      order: found?.order ?? null,
      cwd: s.cwd || null,
    }
  }
  const cwd = s.cwd ? (s.cwd.length > 1 ? s.cwd.replace(/[\\/]+$/, '') : s.cwd) : ''
  return {
    kind: 'folder',
    id: cwd,
    label: cwd ? basename(cwd) || projectDisplayName(s) : projectDisplayName(s),
    order: null,
    cwd: s.cwd || null,
  }
}
