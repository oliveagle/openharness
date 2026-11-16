import { describe, expect, it } from 'vitest'
import { herdrPaneWorkspaceId, parseHerdrWorkspaceList, railRefFor, type HerdrWorkspaceIndex } from './agentRail.js'
import type { RegisteredSession } from './registry.js'
import type { TerminalRuntimeRef } from './terminalTypes.js'

/** The shape `herdr workspace list` gives (protocol 19), trimmed: base-36 ids, sidebar numbers, labels. */
const WORKSPACE_LIST = {
  type: 'workspace_list',
  workspaces: [
    { workspace_id: 'w7', label: 'ole-eval', number: 6, pane_count: 4, focused: true, agent_status: 'working' },
    { workspace_id: 'w1', label: '.agents', number: 1, pane_count: 1, focused: false, agent_status: 'unknown' },
    { workspace_id: 'wA', label: null, number: 7, pane_count: 2, focused: false, agent_status: 'idle' },
    { workspace_id: 'wC', label: 'laya-workflow', number: 9, pane_count: 3, focused: false, agent_status: 'idle' },
    { label: 'no id: dropped', number: 10 },
  ],
}

const session = (over: Partial<RegisteredSession>): RegisteredSession => ({
  agentId: 'a1', sessionId: 's1', engine: 'codex', cwd: '/work/ole-utils-ci',
  primaryRuntimeKey: 'herdr:ep1:w7:p2',
  runtimes: [{ backend: 'herdr', endpointId: 'ep1', sessionName: 'default', terminalId: 't-2', paneId: 'w7:p2' }] as TerminalRuntimeRef[],
  registeredAt: Date.now(), boundAt: Date.now(), lastHookAt: 0, active: true,
  ...over,
} as RegisteredSession)

const index = (): HerdrWorkspaceIndex => new Map(parseHerdrWorkspaceList({ result: WORKSPACE_LIST }).map((each) => [each.id, each]))

describe('parseHerdrWorkspaceList', () => {
  it('reads the sidebar order and every label, base-36 ids included', () => {
    expect(parseHerdrWorkspaceList({ result: WORKSPACE_LIST })).toEqual([
      { id: 'w1', label: '.agents', order: 1, paneCount: 1, focused: false, agentStatus: 'unknown' },
      { id: 'w7', label: 'ole-eval', order: 6, paneCount: 4, focused: true, agentStatus: 'working' },
      { id: 'wA', label: null, order: 7, paneCount: 2, focused: false, agentStatus: 'idle' },
      { id: 'wC', label: 'laya-workflow', order: 9, paneCount: 3, focused: false, agentStatus: 'idle' },
    ])
  })

  it('says nothing for an answer that is not a workspace list, and drops entries without an id', () => {
    expect(parseHerdrWorkspaceList(null)).toEqual([])
    expect(parseHerdrWorkspaceList({ result: { type: 'something_else', workspaces: [] } })).toEqual([])
    expect(parseHerdrWorkspaceList({ result: { ...WORKSPACE_LIST } }).map((each) => each.id)).not.toContain(undefined)
  })
})

describe('herdrPaneWorkspaceId', () => {
  it('is the pane id prefix, for ids past the ninth and past the tenth alike', () => {
    expect(herdrPaneWorkspaceId('w7:p2')).toBe('w7')
    expect(herdrPaneWorkspaceId('wS:p1')).toBe('wS')
    expect(herdrPaneWorkspaceId('wC:pK')).toBe('wC')
  })

  it('refuses what Herdr would not have made', () => {
    expect(herdrPaneWorkspaceId('%12')).toBeNull()
    expect(herdrPaneWorkspaceId('w7')).toBeNull()
    expect(herdrPaneWorkspaceId('')).toBeNull()
  })
})

describe('railRefFor', () => {
  it('groups a Herdr agent under its own workspace, with the sidebar label and order', () => {
    expect(railRefFor(session({}), () => index())).toEqual({
      kind: 'herdr', id: 'w7', label: 'ole-eval', order: 6, cwd: '/work/ole-utils-ci',
    })
  })

  it('keeps the workspace id when the sidebar has not been read yet: the client can still group', () => {
    expect(railRefFor(session({}), () => null)).toEqual({
      kind: 'herdr', id: 'w7', label: null, order: null, cwd: '/work/ole-utils-ci',
    })
  })

  it('reads the index of the endpoint that owns the pane, never another endpoint', () => {
    const other: HerdrWorkspaceIndex = new Map([['w7', { id: 'w7', label: 'someone else', order: 1, paneCount: 1, focused: false, agentStatus: null }]])
    expect(railRefFor(session({}), (endpointId) => endpointId === 'ep1' ? index() : other))
      .toMatchObject({ label: 'ole-eval', order: 6 })
    expect(railRefFor(session({}), (endpointId) => endpointId === 'ep1' ? other : index()))
      .toMatchObject({ label: 'someone else', order: 1 })
  })

  it('groups a tmux agent by its folder, named as the folder is', () => {
    const tmux = session({
      primaryRuntimeKey: 'tmux:%3',
      runtimes: [{ backend: 'tmux', paneId: '%3' }] as TerminalRuntimeRef[],
    })
    expect(railRefFor(tmux, () => index())).toEqual({
      kind: 'folder', id: '/work/ole-utils-ci', label: 'ole-utils-ci', order: null, cwd: '/work/ole-utils-ci',
    })
  })

  it('treats a trailing separator as the same folder, so one folder is one workspace', () => {
    const tmux = session({
      cwd: '/work/ole-utils-ci/',
      primaryRuntimeKey: 'tmux:%3',
      runtimes: [{ backend: 'tmux', paneId: '%3' }] as TerminalRuntimeRef[],
    })
    expect(railRefFor(tmux).id).toBe('/work/ole-utils-ci')
  })

  it('follows the primary runtime: a moved agent reports the workspace it is in now', () => {
    const moved = session({
      primaryRuntimeKey: 'herdr:ep1:wC:pK',
      runtimes: [{ backend: 'herdr', endpointId: 'ep1', sessionName: 'default', terminalId: 't-9', paneId: 'wC:pK' }] as TerminalRuntimeRef[],
    })
    expect(railRefFor(moved, () => index())).toMatchObject({ id: 'wC', label: 'laya-workflow', order: 9 })
  })

  it('still answers for an agent with no runtime and no folder — a stopped one', () => {
    const stopped = session({ cwd: '', primaryRuntimeKey: '', runtimes: [] as TerminalRuntimeRef[], defaultName: 'board fab check' })
    expect(railRefFor(stopped)).toEqual({ kind: 'folder', id: '', label: expect.any(String), order: null, cwd: null })
  })
})
