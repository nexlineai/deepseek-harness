/**
 * Pure helpers for @deepseek-ai/dsh-tui-app — no Cordis context, no shared
 * mutable state, so they are unit-testable in isolation.
 * @module @deepseek-ai/dsh-tui-app/helpers
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Aggregate the final assistant text and turn outcome in one owned interval. */
export function summarize(events: readonly SessionEvent[], firstSeq: number): { text: string; reason: SessionEvent<'turn/end'>['data']['reason'] | undefined } {
  let started = false
  let text = ''
  let reason: SessionEvent<'turn/end'>['data']['reason'] | undefined
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') reason = event.data.reason
  }
  return { text, reason }
}

/** Compact preview of a tool call's JSON arguments. */
export function previewArgs(args: string): string {
  const flat = args.replace(/\s+/g, ' ').trim()
  return flat === '' ? '(no arguments)' : flat.slice(0, 120)
}

/** Compact preview of a tool result message. */
export function previewResult(message: unknown): string {
  try {
    const content = (message as { content?: unknown }).content
    if (typeof content === 'string') return content.replace(/\s+/g, ' ').slice(0, 120)
    if (Array.isArray(content)) {
      const parts = content
        .filter((block): block is { type: string; text?: string } => typeof block === 'object' && block !== null)
        .map(block => block.text ?? '')
        .filter(Boolean)
      return parts.join(' ').replace(/\s+/g, ' ').slice(0, 120)
    }
  } catch {
    // non-serializable result; fall through
  }
  return '(result)'
}

/** Compact one-line summary of a session event for /trajectory. */
export function trajectoryLine(event: SessionEvent): string | undefined {
  const seq = String(event.seq).padStart(4)
  const type = event.type as string
  const data = (event as unknown as { data?: Record<string, unknown> }).data
  const textOf = (value: unknown): string => {
    const message = value as { content?: ReadonlyArray<{ type?: string; text?: string }> }
    return (message.content ?? [])
      .filter(block => block.type === 'text' && block.text !== undefined)
      .map(block => block.text ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .slice(0, 60)
  }
  switch (type) {
    case 'turn/start': return `${seq} ${typeof data?.turn === 'number' && data.turn > 0 ? `▶ turn ${data.turn}` : '▶ turn'}`
    case 'turn/end': return `${seq}  ⏹ ${String((data?.reason as { kind?: string } | undefined)?.kind ?? '')}`
    case 'user/message': {
      const text = textOf(data)
      // Skip injected system reminders / context snapshots.
      const noise = /^<system-reminder>|^Current runtime context|^A skill is a reusable|^The following workspace instructions/
      if (noise.test(text)) return undefined
      return `${seq}  ❯ ${text}`
    }
    case 'assistant/message': return `${seq}  ● ${textOf(data?.message)}`
    case 'tool/call': return `${seq}  ⏱ ${String(data?.name ?? 'tool')} ${String(data?.arguments ?? '').replace(/\s+/g, ' ').slice(0, 40)}`
    case 'tool/result': return `${seq}  ${data?.error !== undefined ? '✖' : '✓'} ${data?.error !== undefined ? String((data.error as { code?: string }).code ?? 'error') : 'ok'}`
    case 'permission/preset': return `${seq}  🔒 permission → ${String(data?.preset ?? '')}`
    case 'sandbox/mode': return `${seq}  🗄 sandbox → ${String(data?.mode ?? '')}`
    case 'plan/mode': return `${seq}  📝 plan mode ${data?.active === true ? 'on' : 'off'}`
    case 'goal/change': return `${seq}  🎯 goal change`
    case 'todo/write': return `${seq}  ☑ todos ${Array.isArray(data?.todos) ? data.todos.length : 0}`
    case 'compaction/end': return `${seq}  🗜 compacted`
    case 'subagent/descriptor': return `${seq}  🤖 subagent`
    case 'approval/asked': return `${seq}  ❓ approval requested`
    case 'approval/decided': return `${seq}  ✅ approval decided`
    default: return undefined
  }
}
