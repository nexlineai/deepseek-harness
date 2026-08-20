import { describe, expect, it, vi } from 'vitest'
import { Tui, width, wrapWords } from '../src/ui.ts'

/** A Tui that never touches the real terminal. */
function makeTui(): Tui {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  return new Tui({
    commands: [],
    onPrompt: () => {},
    onExit: () => {},
    header: '',
    status: '',
  })
}

describe('updateTool', () => {
  it('patches the card matching the call id, not the most recent one', () => {
    // Regression: two tools run in parallel and the first one's result arrives
    // first; the status used to land on the wrong (last-appended) card.
    const ui = makeTui()
    ui.append({ kind: 'tool', text: 'read', name: 'read', callId: 'c1', status: 'running' })
    ui.append({ kind: 'tool', text: 'bash', name: 'bash', callId: 'c2', status: 'running' })

    ui.updateTool('done', 'read output', 'c1')

    const tools = ui.log().filter(e => e.kind === 'tool')
    expect(tools.map(t => [t.callId, t.status])).toEqual([
      ['c1', 'done'],
      ['c2', 'running'],
    ])
  })

  it('records errors against the right card', () => {
    const ui = makeTui()
    ui.append({ kind: 'tool', text: 'a', name: 'a', callId: 'c1', status: 'running' })
    ui.append({ kind: 'tool', text: 'b', name: 'b', callId: 'c2', status: 'running' })

    ui.updateTool('error', 'boom', 'c2')

    const tools = ui.log().filter(e => e.kind === 'tool')
    expect(tools[0]?.status).toBe('running')
    expect(tools[1]?.status).toBe('error')
    expect(tools[1]?.detail).toBe('boom')
  })

  it('falls back to the last running tool when no call id is given', () => {
    const ui = makeTui()
    ui.append({ kind: 'tool', text: 'a', name: 'a', callId: 'c1', status: 'running' })
    ui.updateTool('done', 'ok')
    expect(ui.log().filter(e => e.kind === 'tool')[0]?.status).toBe('done')
  })

  it('does not re-patch a card that already settled', () => {
    const ui = makeTui()
    ui.append({ kind: 'tool', text: 'a', name: 'a', callId: 'c1', status: 'running' })
    ui.updateTool('done', 'first', 'c1')
    ui.updateTool('error', 'stray', undefined)
    expect(ui.log().filter(e => e.kind === 'tool')[0]?.status).toBe('done')
  })
})

describe('width', () => {
  it('ignores ANSI escape sequences', () => {
    expect(width('\x1b[1mbold\x1b[0m')).toBe(4)
  })

  it('counts wide CJK glyphs as two cells', () => {
    expect(width('你好')).toBe(4)
    expect(width('ab你')).toBe(4)
  })

  it('counts emoji as two cells and ignores variation selectors', () => {
    expect(width('🔒')).toBe(2)
    expect(width('🎯done')).toBe(6)
  })

  it('counts plain ASCII as one cell each', () => {
    expect(width('hello')).toBe(5)
  })
})

describe('wrapWords', () => {
  it('wraps on word boundaries', () => {
    expect(wrapWords('the quick brown fox', 10)).toEqual(['the quick', 'brown fox'])
  })

  it('hard-breaks a lone overlong word', () => {
    // Regression: a single long token with no preceding line used to overflow
    // the pane instead of being broken.
    const lines = wrapWords('A'.repeat(50), 20)
    expect(Math.max(...lines.map(l => width(l)))).toBeLessThanOrEqual(20)
    expect(lines.join('')).toBe('A'.repeat(50))
  })

  it('hard-breaks an overlong word that follows normal text', () => {
    const lines = wrapWords(`see ${'B'.repeat(40)}`, 15)
    expect(Math.max(...lines.map(l => width(l)))).toBeLessThanOrEqual(15)
  })

  it('never exceeds the pane with wide glyphs', () => {
    const lines = wrapWords('你'.repeat(30), 10)
    // Each glyph is 2 cells, so a 10-cell pane fits 5 per line, never 10.
    expect(Math.max(...lines.map(l => width(l)))).toBeLessThanOrEqual(10)
  })

  it('preserves explicit newlines and blank lines', () => {
    expect(wrapWords('a\n\nb', 10)).toEqual(['a', '', 'b'])
  })

  it('returns the input when cols is non-positive', () => {
    expect(wrapWords('anything', 0)).toEqual(['anything'])
  })

  it('terminates on a glyph wider than the pane', () => {
    const lines = wrapWords('你好', 1)
    expect(lines.join('')).toBe('你好')
  })
})
