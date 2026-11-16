import { describe, expect, it } from 'vitest'
import { HerdrBackend } from './herdrBackend.js'
import { resolveHerdrEndpoint } from './herdrApiClient.js'
import { herdrPaneWorkspaceId } from './agentRail.js'
import { userInfo } from 'node:os'
import { join } from 'node:path'

const enabled = process.env.RUN_HERDR_REAL === '1' && process.platform !== 'win32'
const CASE = 30_000

async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = await read()
    if (ok(value) || Date.now() > end) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

;(enabled ? describe : describe.skip)('HerdrBackend against the machine\'s running Herdr', () => {
  it('creates a real workspace, runs a command in it, reads and types into it, and closes it', async () => {
    const endpoint = await resolveHerdrEndpoint({
      sessionName: process.env.HERDR_SESSION ?? 'default',
      // `os.userInfo().homedir`, not `homedir()`: vitest.setup.ts points HOME at a throwaway folder,
      // and this case has to reach the Herdr the person is actually running.
      socketPath: process.env.HERDR_REAL_SOCKET || join(userInfo().homedir, '.config/herdr/herdr.sock'),
    })
    const backend = new HerdrBackend(endpoint)
    expect(await backend.prepare({ ownedPanes: new Map() })).toEqual({ state: 'ready' })
    const created = await backend.create({
      cwd: process.cwd(),
      label: `harness-contract-${Date.now()}`,
      command: ['/bin/sh', '-c', 'echo herdr-contract-$((40+2)); exec /bin/sh'],
    })
    expect(created.state).toBe('succeeded')
    if (created.state !== 'succeeded') return
    try {
      const read = await until(
        () => backend.capture(created.runtime, { mode: 'recent_unwrapped', historyLines: 50, ansi: false }),
        (value) => value.state === 'succeeded' && value.value.includes('herdr-contract-42'),
      )
      expect(read).toMatchObject({ state: 'succeeded' })
      if (read.state === 'succeeded') expect(read.value).toContain('herdr-contract-42')
      expect(await backend.rootProcess(created.runtime)).toBeTypeOf('number')
      expect(await backend.paneInfo(created.runtime)).toMatchObject({ pid: expect.any(Number) })
      // The rail's workspace level is Herdr's own sidebar: the workspace this case just made is in it,
      // under the label it was given, and the pane counted there is the one it made.
      const workspaceId = herdrPaneWorkspaceId(created.runtime.paneId)
      expect(workspaceId).not.toBeNull()
      await backend.refreshWorkspaces(Date.now() + 60_000)
      expect(backend.workspaceIndex().get(workspaceId ?? '')).toMatchObject({
        label: expect.stringContaining('harness-contract-'),
        paneCount: 1,
      })
      const inventory = await backend.inventory()
      expect(inventory.state).toBe('available')
      if (inventory.state === 'available') expect(inventory.roots.some((root) => root.runtime.paneId === created.runtime.paneId)).toBe(true)
      await backend.submitText(created.runtime, 'echo typed-$((1+1))')
      const typed = await until(
        () => backend.capture(created.runtime, { mode: 'recent_unwrapped', historyLines: 50, ansi: false }),
        (value) => value.state === 'succeeded' && value.value.includes('typed-2'),
      )
      expect(typed).toMatchObject({ state: 'succeeded' })
      if (typed.state === 'succeeded') expect(typed.value).toContain('typed-2')
    } finally {
      expect((await backend.kill(created.runtime)).state).toBe('succeeded')
      expect(await until(() => backend.paneState(created.runtime), (state) => state === 'gone')).toBe('gone')
    }
  }, CASE)
})
