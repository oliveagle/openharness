import { describe, expect, it } from 'vitest'
import { defaultTerminalBackends, parseHerdrSessions, parseTerminalBackends } from './terminalConfig.js'

describe('terminal backend configuration', () => {
  it('watches tmux, and only tmux, when nothing is configured off Windows', () => {
    expect(defaultTerminalBackends('darwin')).toEqual(['tmux'])
    expect(defaultTerminalBackends('linux')).toEqual(['tmux'])
    expect(defaultTerminalBackends('win32')).toEqual(['ptyhost'])
  })

  it('defaults to ptyhost on Windows only', () => {
    expect(parseTerminalBackends(undefined, 'win32')).toEqual(['ptyhost'])
    expect(parseTerminalBackends(undefined, 'darwin')).toEqual(['tmux'])
    expect(parseTerminalBackends('ptyhost', 'linux')).toEqual(['ptyhost'])
  })

  it('treats an explicit value as a pin', () => {
    expect(parseTerminalBackends('tmux')).toEqual(['tmux'])
    expect(parseTerminalBackends('herdr')).toEqual(['herdr'])
    expect(parseTerminalBackends('herdr,tmux')).toEqual(['herdr', 'tmux'])
  })

  it.each(['', ' ', 'tmux,', 'tmux,,tmux', 'tmux,tmux', 'screen'])('rejects invalid TERMINAL_BACKENDS=%j', (value) => {
    expect(() => parseTerminalBackends(value)).toThrow(/TERMINAL_BACKENDS/)
  })

  it('names every supported backend when it rejects one', () => {
    expect(() => parseTerminalBackends('screen')).toThrow('expected tmux, ptyhost or herdr')
  })
})

describe('Herdr session configuration', () => {
  it('leaves sessions to discovery when unset or empty', () => {
    expect(parseHerdrSessions(undefined)).toBeUndefined()
    expect(parseHerdrSessions('')).toBeUndefined()
  })

  it('accepts the names Herdr itself accepts', () => {
    expect(parseHerdrSessions('default,work.box_2')).toEqual(['default', 'work.box_2'])
  })

  it.each(['has space', '../escape', '-leading', 'a'.repeat(65)])('rejects invalid HERDR_SESSIONS=%j', (value) => {
    expect(() => parseHerdrSessions(value)).toThrow(/HERDR_SESSIONS/)
  })
})
