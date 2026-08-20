/**
 * @deepseek-ai/dsh-tui-app — interactive terminal REPL. The bundle patch rides
 * over dsh-base without Host, HTTP, or browser plugins; this runner creates
 * one Agent through the core registry and drives a full-screen
 * Claude Code / opencode-style surface (see ./ui.ts): conversation scrollback,
 * fixed input bar with prompt history and slash-command completion, status
 * bar, and live token streaming via `assistant/chunk` text deltas.
 *
 * Slash commands: /help /exit /quit /clear /model /status /stream on|off
 *
 * @module @deepseek-ai/dsh-tui-app
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { Tui, type TuiCommand } from './ui.ts'
// Empty type imports carry the loader Context merge for the settlement await
// and the cmdline Context merge for the appExit host value.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'tui-runner'

/** Core services required before the interactive turn can start. */
export const inject = ['agentDefaultModel', 'agents', 'sessions']

/** Plugin config: the seed task and stream mode resolved from the startup provider. */
export interface Config {
  /** Optional seed task submitted on boot; empty starts at the REPL prompt. */
  task: string
  /** Render assistant/chunk text deltas live while the model streams. */
  streaming: boolean
}

export const Config: z<Config> = z.object({
  task: z.string().default(''),
  streaming: z.boolean().default(true),
})

/** Process-facing effects of one REPL run. */
interface TuiIo {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
  /** Request process exit with `code` after the tree disposes. */
  exit(code: number): void
}

/** The subset of an Agent the REPL drives. */
interface TuiAgent {
  session: { seq: number; events: readonly SessionEvent[]; id?: string }
  ctx: { on(event: 'session/event', listener: (session: unknown, event: SessionEvent) => void): () => void }
  followup(message: unknown): void
  whenIdle(): Promise<void>
}

/** Aggregate the final assistant text and turn outcome in one owned interval. */
function summarize(events: readonly SessionEvent[], firstSeq: number): { text: string; reason: SessionEvent<'turn/end'>['data']['reason'] | undefined } {
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

/**
 * Run one turn against `agent`, streaming chunks into the UI and reporting
 * tool activity and the final outcome. Prints the aggregate answer only when
 * nothing was streamed (e.g. streaming disabled).
 * @param agent - the live agent to drive.
 * @param ui - the terminal surface.
 * @param sessions - session store, for the durability flush.
 * @param prompt - the user prompt text.
 * @param streaming - render text deltas live.
 */
async function runTurn(
  agent: TuiAgent,
  ui: Tui,
  sessions: { flush(session: unknown): Promise<unknown> },
  prompt: string,
  streaming: boolean,
): Promise<void> {
  const firstSeq = agent.session.seq
  let streamed = false
  let stop: (() => void) | undefined
  if (streaming) {
    ui.beginStreaming()
    stop = agent.ctx.on('session/event', (session, event) => {
      if (session !== agent.session) return
      if (event.seq < firstSeq) return
      if (event.type === 'assistant/chunk') {
        const chunk = event.data.chunk
        if (chunk.type === 'text-delta') {
          streamed = true
          ui.streamChunk(chunk.text)
        } else if (chunk.type === 'reasoning-delta') {
          ui.streamChunk(chunk.text, true)
        }
      } else if (event.type === 'tool/call') {
        ui.append({
          kind: 'tool',
          text: event.data.name,
          name: event.data.name,
          status: 'running',
          detail: previewArgs(event.data.arguments),
        })
      } else if (event.type === 'tool/result') {
        ui.updateLastTool(
          event.data.error ? 'error' : 'done',
          previewResult(event.data.message),
        )
      } else if (event.type === 'assistant/message' && event.data.usage) {
        ui.addTokens(event.data.usage)
      }
    })
  }
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
  stop?.()
  ui.endStreaming()
  await sessions.flush(agent.session)
  const outcome = summarize(agent.session.events, firstSeq)
  if (!streamed && outcome.text !== '') {
    ui.append({ kind: 'assistant', text: outcome.text })
  }
  if (outcome.reason?.kind === 'error') {
    ui.append({ kind: 'error', text: `${outcome.reason.error.code}: ${outcome.reason.error.message}` })
  }
  ui.append({ kind: 'separator', text: '' })
}

/** Compact preview of a tool call's JSON arguments. */
function previewArgs(args: string): string {
  const flat = args.replace(/\s+/g, ' ').trim()
  return flat === '' ? '(no arguments)' : flat.slice(0, 120)
}

/** Compact preview of a tool result message. */
function previewResult(message: unknown): string {
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

/**
 * Run the interactive REPL through the full-screen surface.
 * @param ctx - plugin context carrying core services and the launcher exit request.
 * @param io - process-facing effects.
 * @param seed - optional boot-time task.
 * @param streaming - initial stream mode.
 */
async function run(ctx: Context, io: TuiIo, seed: string, streaming: boolean): Promise<void> {
  // Loader siblings mount concurrently. Await the complete application before
  // creating an Agent so its scoped tools and adapters are not half-composed.
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  // Early process shutdown can dispose the tree while settlement is pending.
  if (agents === undefined || defaultModel === undefined || sessions === undefined) return

  const selection = defaultModel.currentSelection()
  const { agent } = await agents.create({
    sessionId: SessionId(`session-${randomUUID()}`),
    meta: { cwd: process.cwd() },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: (agentCtx) => {
      const selected: ModelSelectionRef = { current: selection, assembled: undefined }
      installModelSelection(agentCtx, selected)
    },
  })
  await agent.whenIdle()

  const sessionId = agent.session.id ?? '?'
  const shortId = sessionId.replace(/^session-/, '').slice(0, 8)
  const status = (): string =>
    `${selection.provider}/${selection.model} · ${shortId} · ${streaming ? 'stream on' : 'stream off'}`

  const commands: TuiCommand[] = [
    { name: 'help', usage: '', help: 'show this help', handler: () => ui.append({ kind: 'system', text: 'commands: /help /clear /model /status /reasoning on|off /stream on|off /exit — or q / quit / :q' }) },
    { name: 'clear', usage: '', help: 'clear the conversation area', handler: () => ui.clearLog() },
    { name: 'model', usage: '', help: 'show the active model', handler: () => ui.append({ kind: 'system', text: `model: ${selection.provider}/${selection.model}` }) },
    { name: 'status', usage: '', help: 'show session and workspace info', handler: () => ui.append({ kind: 'system', text: `session: ${sessionId} · cwd: ${process.cwd()} · events: ${agent.session.events.length}` }) },
    {
      name: 'reasoning',
      usage: 'on|off',
      help: 'show or hide the model reasoning (thinking) display',
      handler: (args) => {
        const arg = args.toLowerCase()
        if (arg === 'on' || arg === 'off') {
          showReasoning = arg === 'on'
          ui.setShowReasoning(showReasoning)
          ui.append({ kind: 'system', text: `reasoning: ${showReasoning ? 'on' : 'off'}` })
        } else {
          ui.append({ kind: 'system', text: `usage: /reasoning on|off (current: ${showReasoning ? 'on' : 'off'})` })
        }
      },
    },
    {
      name: 'stream',
      usage: 'on|off',
      help: 'toggle live token streaming',
      handler: (args) => {
        const arg = args.toLowerCase()
        if (arg === 'on' || arg === 'off') {
          streaming = arg === 'on'
          ui.append({ kind: 'system', text: `streaming: ${streaming ? 'on' : 'off'}` })
        } else {
          ui.append({ kind: 'system', text: `usage: /stream on|off (current: ${streaming ? 'on' : 'off'})` })
        }
      },
    },
    { name: 'exit', usage: '', help: 'leave the session', handler: () => ui.requestExit() },
    { name: 'quit', usage: '', help: 'leave the session', handler: () => ui.requestExit() },
  ]

  let showReasoning = true

  const ui = new Tui({
    commands,
    status: status(),
    onPrompt: (line) => {
      void (async () => {
        ui.append({ kind: 'user', text: line })
        ui.setBusy(true)
        ui.setStatus(status())
        try {
          await runTurn(agent, ui, sessions, line, streaming)
        } finally {
          ui.setBusy(false)
          ui.setStatus(status())
        }
      })()
    },
    onExit: () => {
      io.stdout.write('\n')
      io.exit(0)
    },
  })
  ui.start()

  // Seed task: run through the same turn path, then the user keeps prompting.
  if (seed.trim() !== '') {
    ui.submit(seed)
  }
}

/**
 * Mount the interactive REPL driver.
 * @param ctx - plugin context carrying core services and the launcher-provided exit request.
 * @param config - validated REPL config.
 */
export function apply(ctx: Context, config: Config): void {
  // Read through the global service store, not the property proxy: appExit is
  // an optional host value, never an injected dependency.
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('tui-runner: the launcher must provide ctx.appExit before the tree mounts')
  }
  const io: TuiIo = { stdout: process.stdout, stderr: process.stderr, exit }
  void run(ctx, io, config.task, config.streaming).catch((error: unknown) => {
    io.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`)
    io.exit(1)
  })
}
