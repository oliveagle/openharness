import { describe, expect, it, vi } from 'vitest'
import { HerdrBackend, herdrShellCommand } from './herdrBackend.js'
import type { HerdrApiClient, HerdrEndpoint } from './herdrApiClient.js'
import { terminalRouteKey } from './terminalRuntime.js'
import type { HerdrRuntimeRef } from './terminalTypes.js'

const endpoint: HerdrEndpoint = {
  sessionName: 'default',
  endpointId: 'endpoint-a',
  socketPath: '/configured/herdr.sock',
  generation: { device: 1, inode: 2 },
}
const runtime: HerdrRuntimeRef = {
  backend: 'herdr', endpointId: 'endpoint-a', sessionName: 'default', terminalId: 'terminal-a', paneId: 'w1:p1',
}

const pong = vi.fn(async () => ({ ok: true as const, result: { type: 'pong' as const, version: '0.8.0', protocol: 19 } }))

function backendWith(request: unknown, ping: unknown = pong): HerdrBackend {
  return new HerdrBackend(endpoint, { request, ping, endpoint } as unknown as HerdrApiClient)
}

const snapshotOf = (panes: unknown[]) => ({
  ok: true as const,
  result: { type: 'session_snapshot', snapshot: { version: '0.8.0', protocol: 19, panes } },
})

describe('herdrShellCommand', () => {
  it('single-quotes every word, and a quote inside one closes, escapes and reopens', () => {
    expect(herdrShellCommand(['claude', '--session', 'a b'])).toBe(`'claude' '--session' 'a b'`)
    expect(herdrShellCommand([`it's`])).toBe(`'it'\\''s'`)
    expect(herdrShellCommand(['a;rm -rf /'])).toBe(`'a;rm -rf /'`)
    expect(herdrShellCommand([])).toBe('')
  })
})

describe('HerdrBackend', () => {
  it('reads endpoint-scoped pane labels and terminal titles from the API snapshot', async () => {
    const backend = backendWith(vi.fn(async () => snapshotOf([
      { pane_id: 'w1:p1', terminal_id: 'terminal-a', label: 'manual label', terminal_title_stripped: 'shell title' },
      { pane_id: 'w1:p2', terminal_id: 'terminal-b', terminal_title_stripped: 'terminal title' },
      { pane_id: 'w1:p3', terminal_id: 'terminal-c' },
    ])))
    const result = await backend.titles()
    expect(result.state).toBe('succeeded')
    if (result.state !== 'succeeded') return
    expect([...result.value.entries()]).toEqual([
      [terminalRouteKey(runtime), 'manual label'],
      [terminalRouteKey({ ...runtime, terminalId: 'terminal-b', paneId: 'w1:p2' }), 'terminal title'],
    ])
  })

  it('distinguishes a successful empty snapshot from unavailable transport', async () => {
    expect(await backendWith(vi.fn(async () => snapshotOf([]))).inventory()).toEqual({ state: 'available', roots: [] })

    const unavailable = backendWith(vi.fn(), vi.fn(async () => ({
      ok: false as const, dispatch: 'not_started' as const, reason: 'Herdr API unavailable',
    })))
    expect(await unavailable.inventory()).toEqual({ state: 'unavailable', reason: 'Herdr API unavailable' })
  })

  it('builds endpoint-scoped roots from the snapshot and each pane\'s process info', async () => {
    const request = vi.fn(async (method: string) => method === 'session.snapshot'
      ? snapshotOf([{ pane_id: 'w1:p1', terminal_id: 'terminal-a', cwd: '/work' }])
      : { ok: true as const, result: { type: 'pane_process_info', process_info: { pane_id: 'w1:p1', shell_pid: 42 } } })
    expect(await backendWith(request).inventory()).toEqual({
      state: 'available',
      roots: [{ runtime, rootPid: 42, cwd: '/work' }],
    })
  })

  it('creates a workspace and types the engine launch line into its root pane', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'workspace.create') {
        return {
          ok: true as const,
          result: {
            type: 'workspace_created',
            workspace: { workspace_id: 'workspace-created' },
            root_pane: { pane_id: 'w2:p1', terminal_id: 'terminal-created', workspace_id: 'workspace-created' },
          },
        }
      }
      return { ok: true as const, result: { type: 'ok' } }
    })
    const dispatch = vi.fn()
    const created = await backendWith(request).create({
      cwd: '/tmp/work', label: 'Harness test', env: { GRID_KEY: 'k' }, command: ['claude', '--dangerously'], current: () => true, onDispatch: dispatch,
    })

    expect(created).toEqual({
      state: 'succeeded',
      dispatch: 'executed',
      runtime: { backend: 'herdr', endpointId: 'endpoint-a', sessionName: 'default', terminalId: 'terminal-created', paneId: 'w2:p1' },
    })
    expect(dispatch).toHaveBeenCalledOnce()
    expect(request.mock.calls).toEqual([
      ['workspace.create', { cwd: '/tmp/work', focus: false, label: 'Harness test', env: { GRID_KEY: 'k' } }, { mutation: 'other' }],
      ['pane.send_input', { pane_id: 'w2:p1', text: `'claude' '--dangerously'`, keys: ['Enter'] }, { mutation: 'single_enqueue' }],
    ])
  })

  it('names the workspace after the agent and puts it in the agent\'s own folder', async () => {
    const request = vi.fn(async (method: string) => method === 'workspace.create'
      ? {
        ok: true as const,
        result: {
          type: 'workspace_created',
          workspace: { workspace_id: 'w9' },
          root_pane: { pane_id: 'w9:p1', terminal_id: 'term-9' },
        },
      }
      : { ok: true as const, result: { type: 'ok' } })
    await backendWith(request).create({
      cwd: '/home/someone', workspaceCwd: '/work/auth', workspaceLabel: 'auth-review', label: 'harness-codex-1', command: ['codex'],
    })
    expect(request.mock.calls[0]).toEqual([
      'workspace.create', { cwd: '/work/auth', focus: false, label: 'auth-review', env: {} }, { mutation: 'other' },
    ])
  })

  it('does not dispatch a create whose authority fence closed, or one asking for a held pane', async () => {
    const request = vi.fn()
    const backend = backendWith(request)
    expect(await backend.create({ cwd: '/tmp/work', current: () => false })).toMatchObject({ state: 'failed', dispatch: 'not_started' })
    expect(await backend.create({ cwd: '/tmp/work', expectedHeldToken: 'token' })).toMatchObject({ state: 'failed', dispatch: 'not_started' })
    expect(request).not.toHaveBeenCalled()
  })

  it('closes the pane, and calls a pane Herdr no longer has already killed', async () => {
    let pane = { ok: true as const, result: { type: 'pane_info', pane: { pane_id: 'w1:p1', terminal_id: 'terminal-a' } } } as unknown
    const request = vi.fn(async (method: string) => method === 'pane.get' ? pane : { ok: true as const, result: { type: 'ok' } })
    const backend = backendWith(request)

    await expect(backend.kill(runtime)).resolves.toEqual({ state: 'succeeded', dispatch: 'executed' })
    expect(request).toHaveBeenLastCalledWith('pane.close', { pane_id: 'w1:p1' }, { mutation: 'other' })

    pane = { ok: false as const, dispatch: 'rejected' as const, code: 'pane_not_found', reason: 'Herdr API rejected pane_not_found' }
    await expect(backend.kill(runtime)).resolves.toEqual({ state: 'succeeded', dispatch: 'executed' })

    pane = { ok: true as const, result: { type: 'pane_info', pane: { pane_id: 'w1:p1', terminal_id: 'someone-else' } } }
    expect(await backend.kill(runtime)).toMatchObject({ state: 'failed', dispatch: 'not_started' })
  })

  it('refuses a runtime of another configured endpoint without touching the socket', async () => {
    const request = vi.fn()
    const backend = backendWith(request)
    const foreign = { ...runtime, endpointId: 'endpoint-b' }
    expect(await backend.kill(foreign)).toMatchObject({ state: 'failed', dispatch: 'not_started' })
    expect(await backend.submitText(foreign, 'hello')).toMatchObject({ state: 'failed', dispatch: 'not_started' })
    expect(await backend.sendKey(foreign, 'enter')).toMatchObject({ state: 'failed', dispatch: 'not_started' })
    expect(await backend.capture(foreign)).toMatchObject({ state: 'failed' })
    expect(request).not.toHaveBeenCalled()
  })

  it('submits stripped text once and keeps ambiguous dispatch evidence', async () => {
    const request = vi.fn(async () => ({
      ok: false as const, dispatch: 'possibly_executed' as const, reason: 'Herdr API response ended early',
    }))
    const result = await backendWith(request).submitText(runtime, 'one\ntwo\n\n')
    expect(request).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith('pane.send_input', { pane_id: 'w1:p1', text: 'one\ntwo', keys: ['Enter'] }, { mutation: 'single_enqueue' })
    expect(result).toEqual({ state: 'unknown', dispatch: 'possibly_executed', reason: 'Herdr API response ended early' })
  })

  it('drops a submit whose authority fence closed before the send', async () => {
    const request = vi.fn()
    expect(await backendWith(request).submitText(runtime, 'hello', { allowed: () => false })).toMatchObject({ state: 'failed', dispatch: 'not_started' })
    expect(request).not.toHaveBeenCalled()
  })

  it('uses the pane route for capture and the named key for a logical key', async () => {
    const request = vi.fn(async (method: string) => method === 'pane.read'
      ? { ok: true as const, result: { type: 'pane_read', read: { text: '\u001b[31mred\u001b[0m' } } }
      : { ok: true as const, result: { type: 'ok' } })
    const backend = backendWith(request)
    await expect(backend.capture(runtime, { historyLines: 60 })).resolves.toEqual({ state: 'succeeded', value: '\u001b[31mred\u001b[0m' })
    expect(request).toHaveBeenCalledWith('pane.read', {
      pane_id: 'w1:p1', source: 'recent_unwrapped', lines: 60, format: 'ansi', strip_ansi: false,
    })
    await expect(backend.sendKey(runtime, 'ctrl-c')).resolves.toEqual({ state: 'succeeded', dispatch: 'executed' })
    expect(request).toHaveBeenLastCalledWith('pane.send_keys', { pane_id: 'w1:p1', keys: ['Ctrl+C'] }, { mutation: 'single_key' })
  })

  it('turns stream bytes into literal runs and the named keys people type', async () => {
    const request = vi.fn(async () => ({ ok: true as const, result: { type: 'ok' } }))
    const backend = backendWith(request)
    await expect(backend.writeInput(runtime, new TextEncoder().encode('ls -l\r'))).resolves.toEqual({ state: 'succeeded', dispatch: 'executed' })
    expect(request.mock.calls).toEqual([
      ['pane.send_text', { pane_id: 'w1:p1', text: 'ls -l' }, { mutation: 'single_enqueue' }],
      ['pane.send_keys', { pane_id: 'w1:p1', keys: ['Enter'] }, { mutation: 'single_key' }],
    ])

    request.mockClear()
    // A byte with no Herdr key name is refused, so the caller knows the keystroke did not land.
    expect(await backend.writeInput(runtime, new Uint8Array([0x1a]))).toMatchObject({ state: 'failed', dispatch: 'not_started' })
    expect(request).not.toHaveBeenCalled()
  })

  it('titles a pane, notifies, and reports a pane Herdr still holds as alive', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'pane.get') return { ok: true as const, result: { type: 'pane_info', pane: { pane_id: 'w1:p1', terminal_id: 'terminal-a' } } }
      if (method === 'pane.process_info') {
        return {
          ok: true as const,
          result: { type: 'pane_process_info', process_info: { pane_id: 'w1:p1', shell_pid: 42, tty: '/dev/pts/9', foreground_processes: [{ pid: 77, name: 'claude', cwd: '/work' }] } },
        }
      }
      return { ok: true as const, result: { type: 'ok' } }
    })
    const backend = backendWith(request)

    await expect(backend.setTitle(runtime, 'x'.repeat(300))).resolves.toEqual({ state: 'succeeded', dispatch: 'executed' })
    expect(request).toHaveBeenCalledWith('pane.rename', { pane_id: 'w1:p1', label: 'x'.repeat(200) }, { mutation: 'other' })
    await expect(backend.notify(runtime, 'done', 'it finished')).resolves.toEqual({ state: 'succeeded', dispatch: 'executed' })
    expect(request).toHaveBeenCalledWith('notification.show', { title: 'done', body: 'it finished', sound: 'none' }, { mutation: 'other' })
    await expect(backend.paneInfo(runtime)).resolves.toEqual({ command: 'claude', path: '/work', pid: 77, tty: '/dev/pts/9' })
    await expect(backend.rootProcess(runtime)).resolves.toBe(42)
    // Herdr keeps the shell and gives no exit status: the pane is alive, and identity is proven from the process table.
    await expect(backend.paneState(runtime)).resolves.toEqual({ dead: false, exitStatus: null, command: 'claude', engineExit: null })
  })

  it("reads Herdr's sidebar once per TTL, keeps the last labels when Herdr goes away, and groups a pane by its workspace", async () => {
    const list = {
      ok: true as const,
      result: {
        type: 'workspace_list',
        workspaces: [
          { workspace_id: 'w7', label: 'ole-eval', number: 6, pane_count: 4, focused: true, agent_status: 'working' },
          { workspace_id: 'wA', label: 'laya-workflow', number: 7, pane_count: 3, focused: false, agent_status: 'idle' },
        ],
      },
    }
    type Answer = { ok: true; result: unknown } | { ok: false; dispatch: 'not_started'; reason: string }
    const request = vi.fn(async (method: string): Promise<Answer> => method === 'workspace.list' ? list : snapshotOf([]))
    const backend = backendWith(request)
    expect(backend.workspaceIndex().size).toBe(0)
    await backend.refreshWorkspaces(1_000)
    expect([...backend.workspaceIndex().keys()]).toEqual(['w7', 'wA'])
    expect(backend.workspaceIndex().get('w7')).toEqual({ id: 'w7', label: 'ole-eval', order: 6, paneCount: 4, focused: true, agentStatus: 'working' })
    // Within the TTL nothing is asked again: frames read the last read.
    await backend.refreshWorkspaces(2_000)
    expect(request.mock.calls.filter(([method]) => method === 'workspace.list')).toHaveLength(1)
    // Past it, Herdr is asked again — and a failed read leaves what it said last standing.
    request.mockImplementationOnce(async () => ({ ok: false as const, dispatch: 'not_started' as const, reason: 'Herdr API unavailable' }))
    await backend.refreshWorkspaces(60_000)
    expect(backend.workspaceIndex().get('w7')?.label).toBe('ole-eval')
  })

  it('asks for the sidebar as it inventories, without waiting on it', async () => {
    type Answer = { ok: true; result: unknown } | { ok: false; dispatch: 'not_started'; reason: string }
    const request = vi.fn(async (method: string): Promise<Answer> => method === 'workspace.list'
      ? { ok: true as const, result: { type: 'workspace_list', workspaces: [{ workspace_id: 'w1', label: 'work', number: 1, pane_count: 1, focused: false, agent_status: null }] } }
      : snapshotOf([]))
    const backend = backendWith(request)
    await backend.inventory()
    await backend.refreshWorkspaces(60_000)
    expect(backend.workspaceIndex().get('w1')?.label).toBe('work')
  })

  it('reads a pane hint back as a runtime, and treats a moved pane as gone', async () => {
    const request = vi.fn(async () => ({
      ok: true as const,
      result: { type: 'pane_info', pane: { pane_id: 'w1:p1', terminal_id: 'terminal-moved' } },
    }))
    const backend = backendWith(request)
    await expect(backend.resolveRuntimeHint('w1:p1')).resolves.toEqual({
      state: 'succeeded',
      value: { backend: 'herdr', endpointId: 'endpoint-a', sessionName: 'default', terminalId: 'terminal-moved', paneId: 'w1:p1' },
    })
    await expect(backend.validate(runtime, { engine: 'claude' } as never)).resolves.toEqual({
      state: 'gone', reason: 'Herdr terminal identity changed under pane route',
    })
  })
})
