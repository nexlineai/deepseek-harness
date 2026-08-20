import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { previewArgs, previewResult, resultCallId, summarize, trajectoryLine } from '../src/helpers.ts'

/** Build a minimal event-shaped value; only the fields each helper reads matter. */
function ev(partial: Record<string, unknown>): SessionEvent {
  return partial as unknown as SessionEvent
}

describe('previewArgs', () => {
  it('returns a marker for empty arguments', () => {
    expect(previewArgs('')).toBe('(no arguments)')
    expect(previewArgs('   ')).toBe('(no arguments)')
  })

  it('collapses whitespace', () => {
    expect(previewArgs('{ "a": 1,\n  "b": 2 }')).toBe('{ "a": 1, "b": 2 }')
  })

  it('truncates to 120 characters', () => {
    const long = 'x'.repeat(200)
    expect(previewArgs(long)).toBe('x'.repeat(120))
  })
})

describe('previewResult', () => {
  it('renders string content', () => {
    expect(previewResult({ content: 'hello world' })).toBe('hello world')
  })

  it('renders text blocks from an array', () => {
    expect(previewResult({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toBe('a b')
  })

  it('falls back to a marker for unknown shapes', () => {
    expect(previewResult({})).toBe('(result)')
    expect(previewResult(null)).toBe('(result)')
  })
})

describe('resultCallId', () => {
  it('reads the call identity from a tool-result block', () => {
    const message = { content: [{ type: 'tool-result', toolCallId: 'call_42', content: [] }] }
    expect(resultCallId(message)).toBe('call_42')
  })

  it('returns undefined when no identity is present', () => {
    expect(resultCallId({ content: [{ type: 'text', text: 'hi' }] })).toBeUndefined()
    expect(resultCallId({ content: 'plain string' })).toBeUndefined()
    expect(resultCallId({})).toBeUndefined()
    expect(resultCallId(null)).toBeUndefined()
    expect(resultCallId(undefined)).toBeUndefined()
  })
})

describe('summarize', () => {
  it('collects the final assistant text within the turn window', () => {
    const events = [
      ev({ seq: 0, type: 'turn/start', data: { turn: 1 } }),
      ev({ seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'partial' }] } } }),
      ev({ seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'final' }] } } }),
      ev({ seq: 3, type: 'turn/end', data: { reason: { kind: 'completed' } } }),
    ]
    const outcome = summarize(events, 0)
    expect(outcome.text).toBe('final')
    expect(outcome.reason?.kind).toBe('completed')
  })

  it('ignores events before firstSeq and non-text blocks', () => {
    const events = [
      ev({ seq: 0, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'stale' }] } } }),
      ev({ seq: 1, type: 'turn/start', data: { turn: 1 } }),
      ev({ seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'tool_use', id: 'x' }] } } }),
      ev({ seq: 3, type: 'turn/end', data: { reason: { kind: 'completed' } } }),
    ]
    expect(summarize(events, 1).text).toBe('')
  })
})

describe('trajectoryLine', () => {
  it('renders a turn start', () => {
    expect(trajectoryLine(ev({ seq: 7, type: 'turn/start', data: { turn: 3 } }))).toBe('   7 ▶ turn 3')
  })

  it('filters injected system reminders from user messages', () => {
    const noisy = ev({ seq: 10, type: 'user/message', data: { content: [{ type: 'text', text: '<system-reminder> do not leak' }] } })
    expect(trajectoryLine(noisy)).toBeUndefined()
  })

  it('renders a real user message', () => {
    const real = ev({ seq: 10, type: 'user/message', data: { content: [{ type: 'text', text: 'say hi' }] } })
    expect(trajectoryLine(real)).toContain('say hi')
  })

  it('renders a tool call', () => {
    const call = ev({ seq: 12, type: 'tool/call', data: { name: 'bash', arguments: '{"c":"ls"}' } })
    expect(trajectoryLine(call)).toContain('⏱ bash')
  })

  it('returns undefined for unknown event types', () => {
    expect(trajectoryLine(ev({ seq: 1, type: 'step/start', data: {} }))).toBeUndefined()
  })
})
