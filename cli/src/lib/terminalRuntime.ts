import type { AgentEngine } from '../engines/types.js'
import { PTY_HOST_PANE } from './ptyHost/instance.js'
import type { ProcessIdentity, TerminalBackendName, TerminalRuntimeRef } from './terminalTypes.js'

const SEP = '\u0000'

/**
 * A Herdr pane route (`w<workspace>:p<pane>`), as `herdr pane list` prints it. Both halves are Herdr's
 * own counters written in base 36 — `w1:p1` beside `w3:pY`, `w7:pK` and `wN:p1` on one machine — so
 * digits alone rejected every pane made after the tenth, and every workspace after the ninth.
 */
export const HERDR_PANE = /^w[0-9A-Za-z]{1,9}:p[0-9A-Za-z]{1,9}$/

function assertKeyPart(value: string, field: string): string {
  if (!value || value.includes(SEP)) throw new Error(`invalid ${field}`)
  return value
}

/**
 * The panes [sessions] hold on [backend] (pane id → the row's engine), for that backend's `prepare`. Only
 * its own: pane ids are per backend (`%N` on tmux and on ptyhost alike), and tmux renames the legacy
 * session of any pane it is handed.
 */
export function ownedPanesOf(
  sessions: Iterable<{ engine: AgentEngine; runtimes: readonly TerminalRuntimeRef[] }>,
  backend: TerminalBackendName,
): Map<string, AgentEngine> {
  const owned = new Map<string, AgentEngine>()
  for (const session of sessions) {
    for (const runtime of session.runtimes) if (runtime.backend === backend) owned.set(runtime.paneId, session.engine)
  }
  return owned
}

/** Stable route key. A ptyhost pane id is only unique within its host instance, so the instance is part of it. */
export function terminalRouteKey(runtime: TerminalRuntimeRef): string {
  const pane = assertKeyPart(runtime.paneId, 'pane id')
  if (runtime.backend === 'tmux') return `tmux${SEP}${pane}`
  if (runtime.backend === 'ptyhost') return `ptyhost${SEP}${assertKeyPart(runtime.instance, 'pty host instance')}${SEP}${pane}`
  return `herdr${SEP}${assertKeyPart(runtime.endpointId, 'Herdr endpoint id')}${SEP}${pane}`
}

/** The backend instance that holds [runtime]: `<backend>:<instance>`, as `TerminalBackend.instanceId`. */
export function terminalInstanceId(runtime: TerminalRuntimeRef): string {
  if (runtime.backend === 'tmux') return 'tmux:default'
  if (runtime.backend === 'ptyhost') return `ptyhost:${runtime.instance}`
  return `herdr:${assertKeyPart(runtime.endpointId, 'Herdr endpoint id')}`
}

/** Human-readable locator label for status and logs. It never contains a Herdr socket path. */
export function terminalRuntimeLabel(runtime: TerminalRuntimeRef): string {
  if (runtime.backend === 'tmux') return `tmux:${runtime.paneId}`
  if (runtime.backend === 'ptyhost') return `ptyhost:${runtime.instance}:${runtime.paneId}`
  return `herdr:${runtime.sessionName}:${runtime.paneId}`
}

/**
 * The runtime a session is reached through first. Rows keep at least one (registry.ts `strictPersistedRow`).
 * First in sort order (`mergeTerminalRuntimes`), not the registry's `primaryRuntimeKey`.
 */
export function primaryRuntime(session: { readonly runtimes: readonly TerminalRuntimeRef[] }): TerminalRuntimeRef {
  return session.runtimes[0]
}

/**
 * The row a shell's own word about its pane names (`harness remote`, `harness send`). A bare `%N` is `$TMUX_PANE`,
 * so a tmux pane and nothing else: a pty host's `%N` is another pane, which only its own `<instance>:%N`
 * (`$HARNESS_PANE`) names. Never the bare `tmuxPane`, which is a ptyhost pane's id on a ptyhost row.
 */
export function sessionForPaneId<S extends { readonly runtimes: readonly TerminalRuntimeRef[] }>(sessions: readonly S[], pane: string): S | undefined {
  const pty = PTY_HOST_PANE.exec(pane)
  if (pty) return sessions.find((session) => session.runtimes.some((runtime) => runtime.backend === 'ptyhost' && runtime.instance === pty[1] && runtime.paneId === pty[2]))
  const herdr = HERDR_PANE.exec(pane)
  if (herdr) return sessions.find((session) => session.runtimes.some((runtime) => runtime.backend === 'herdr' && runtime.paneId === pane))
  return sessions.find((session) => session.runtimes.some((runtime) => runtime.backend === 'tmux' && runtime.paneId === pane))
}

/** Stable placement key. A Herdr pane move keeps this key because terminal_id is the placement identity. */
export function terminalPlacementKey(runtime: TerminalRuntimeRef): string {
  if (runtime.backend === 'herdr') {
    return `herdr${SEP}${assertKeyPart(runtime.endpointId, 'Herdr endpoint id')}${SEP}${assertKeyPart(runtime.terminalId, 'Herdr terminal id')}`
  }
  return terminalRouteKey(runtime)
}

/** What says which process a number is: its pid and when it started. */
type ProcessStart = Pick<ProcessIdentity, 'pid' | 'startMarker' | 'startTicks'>

function startTicks(identity: ProcessStart): number | undefined {
  return Number.isSafeInteger(identity.startTicks) && identity.startTicks! >= 0 ? identity.startTicks : undefined
}

/** Keyed by the start ticks when known: the marker of the same process moves with the wall clock. */
export function processIdentityKey(engine: string, identity: ProcessIdentity): string {
  const ticks = startTicks(identity)
  const start = ticks === undefined ? assertKeyPart(identity.startMarker, 'process start marker') : `t:${ticks}`
  return `${assertKeyPart(engine, 'engine')}${SEP}${identity.pid}${SEP}${start}`
}

/**
 * pid + start time is a process. The start ticks decide when both sides have them (see
 * `ProcessIdentity.startTicks`); otherwise the `ps` marker, as before them — which is also how a row
 * saved before them is matched once, and then saved with them.
 */
export function sameProcessIdentity(a: ProcessStart | undefined | null, b: ProcessStart | undefined | null): boolean {
  if (!a || !b || a.pid !== b.pid) return false
  const ticksA = startTicks(a)
  const ticksB = startTicks(b)
  return ticksA !== undefined && ticksB !== undefined ? ticksA === ticksB : a.startMarker === b.startMarker
}

/**
 * The process an agent was bound to still runs among its pane's [processes], whatever its name now: a wrapper that
 * `exec`s keeps its pid and start under another name, and its agent was reported stopped while it ran (lamp-9adf,
 * 2026-11-13, #4259).
 */
export function processAmong(recorded: ProcessStart | undefined | null, processes: readonly ProcessStart[] | undefined): boolean {
  return !!recorded && !!processes?.some((process) => sameProcessIdentity(recorded, process))
}

/** The identity a row stands for, without the rest of the row. */
export function processIdentityOf(row: ProcessIdentity): ProcessIdentity {
  return {
    pid: row.pid, executable: row.executable, startMarker: row.startMarker,
    ...(row.startTicks !== undefined ? { startTicks: row.startTicks } : {}),
  }
}

export function sameTerminalPlacement(a: TerminalRuntimeRef, b: TerminalRuntimeRef): boolean {
  return terminalPlacementKey(a) === terminalPlacementKey(b)
}

/** Merge observed runtimes into the current set without duplicating a placement. */
export function mergeTerminalRuntimes(
  current: readonly TerminalRuntimeRef[],
  observed: readonly TerminalRuntimeRef[],
): TerminalRuntimeRef[] {
  const merged = new Map<string, TerminalRuntimeRef>()
  for (const runtime of current) merged.set(terminalPlacementKey(runtime), runtime)
  for (const runtime of observed) merged.set(terminalPlacementKey(runtime), runtime)
  return [...merged.values()].sort((a, b) => terminalPlacementKey(a).localeCompare(terminalPlacementKey(b)))
}
