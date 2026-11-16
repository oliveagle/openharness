import type { TerminalBackendName } from '../lib/terminalTypes.js'

/** Herdr's own session-name rule, from its socket API. */
export const HERDR_SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** The backends the daemon drives when none are configured: the pty host on Windows, tmux everywhere else. */
export function defaultTerminalBackends(platform: NodeJS.Platform = process.platform): TerminalBackendName[] {
  return platform === 'win32' ? ['ptyhost'] : ['tmux']
}

function strictList(value: string, field: string): string[] {
  const parts = value.split(',').map((part) => part.trim())
  if (!parts.length || parts.some((part) => !part)) {
    throw new Error(`${field} must be a non-empty comma-separated list`)
  }
  if (new Set(parts).size !== parts.length) throw new Error(`${field} must not contain duplicates`)
  return parts
}

/**
 * The backends `value` names, or this platform's defaults when it is unset.
 *
 * `herdr` is a supported backend again. Every Herdr pane the daemon makes is a real Herdr workspace,
 * so the person can attach to it from the Herdr app, while Harness keeps driving the same panes over
 * Herdr's socket API.
 */
export function parseTerminalBackends(value?: string, platform: NodeJS.Platform = process.platform): TerminalBackendName[] {
  if (value === undefined) return defaultTerminalBackends(platform)
  const values = strictList(value, 'TERMINAL_BACKENDS')
  const kept: TerminalBackendName[] = []
  for (const backend of values) {
    if (backend === 'tmux' || backend === 'ptyhost' || backend === 'herdr') { kept.push(backend); continue }
    throw new Error(`TERMINAL_BACKENDS contains unsupported backend "${backend}"; expected tmux, ptyhost or herdr`)
  }
  if (!kept.length) {
    const fallback = defaultTerminalBackends(platform)
    console.warn(`[terminal] TERMINAL_BACKENDS named no supported backend — falling back to ${fallback.join(', ')}`)
    return fallback
  }
  return kept
}

/**
 * The Herdr sessions to drive. Unset means AUTO: every running Herdr session on this machine is
 * discovered (`herdr session list --json`), so a person who starts Herdr with any name — including
 * the default session already attached in their terminal — gets those panes in Harness with no setup.
 */
export function parseHerdrSessions(value?: string): string[] | undefined {
  if (value === undefined || value === '') return undefined
  const values = strictList(value, 'HERDR_SESSIONS')
  for (const session of values) {
    if (!HERDR_SESSION_RE.test(session)) throw new Error(`HERDR_SESSIONS contains invalid session name "${session}"`)
  }
  return values
}
