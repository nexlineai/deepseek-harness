/**
 * @deepseek-ai/dsh-tui-app — interactive terminal REPL. The bundle patch rides
 * over dsh-base without Host, HTTP, or browser plugins; this runner creates
 * one Agent through the core registry, drives turns with live token streaming
 * (`assistant/chunk` text deltas), renders user/tool/assistant lines with
 * ANSI colors in the alternate screen, and re-prompts until the user exits.
 *
 * Slash commands: /help /exit /quit /clear /model /status /stream on|off
 *
 * @module @deepseek-ai/dsh-tui-app
 */

import { randomUUID } from 'node:crypto'
import { createInterface, type Interface } from 'node:readline'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
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

/** The process streams the runner writes to; tests substitute captures. */
export const internals: { stdout: TuiIo['stdout']; stderr: TuiIo['stderr'] } = {
  stdout: process.stdout,
  stderr: process.stderr,
}

/** Minimal ANSI styling for the terminal surface. */
const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  clearScreen: '\x1b[2J\x1b[H',
  altEnter: '\x1b[?1049h',
  altLeave: '\x1b[?1049l',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
} as const

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

/** The subset of an Agent the REPL drives. */
interface TuiAgent {
  session: { seq: number; events: readonly SessionEvent[] }
  ctx: { on(event: 'session/event', listener: (session: unknown, event: SessionEvent) => void): () => void }
  followup(message: unknown): void
  whenIdle(): Promise<void>
}

/**
 * Run one turn against `agent`: subscribe to live chunks (when streaming),
 * submit the user message, wait for quiescence, flush the session, then print
 * the aggregate answer (only when not already streamed).
 * @param agent - the live agent to drive.
 * @param io - process-facing effects.
 * @param sessions - session store, for the durability flush.
 * @param prompt - the user prompt text.
 * @param streaming - render text deltas live.
 * @param onTool - callback for dim tool-activity lines.
 */
async function runTurn(
  agent: TuiAgent,
  io: TuiIo,
  sessions: { flush(session: unknown): Promise<unknown> },
  prompt: string,
  streaming: boolean,
  onTool: (name: string) => void,
): Promise<{ text: string; streamed: boolean; reason: SessionEvent<'turn/end'>['data']['reason'] | undefined }> {
  const firstSeq = agent.session.seq
  let streamed = false
  let stop: (() => void) | undefined
  if (streaming) {
    stop = agent.ctx.on('session/event', (session, event) => {
      if (session !== agent.session) return
      if (event.seq < firstSeq) return
      if (event.type === 'assistant/chunk') {
        const chunk = event.data.chunk
        if (chunk.type === 'text-delta') {
          streamed = true
          io.stdout.write(chunk.text)
        }
      } else if (event.type === 'tool/call') {
        onTool(String(event.data.name ?? 'tool'))
      }
    })
  }
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
  stop?.()
  await sessions.flush(agent.session)
  const outcome = summarize(agent.session.events, firstSeq)
  if (!streamed && outcome.text !== '') io.stdout.write(outcome.text + '\n')
  if (outcome.reason?.kind === 'error') {
    io.stderr.write(`${ANSI.red}dsh: ${outcome.reason.error.code}: ${outcome.reason.error.message}${ANSI.reset}\n`)
  }
  return { ...outcome, streamed }
}

/** Render one user prompt line. */
function printUser(io: TuiIo, text: string): void {
  io.stdout.write(`${ANSI.cyan}${ANSI.bold}❯ ${text}${ANSI.reset}\n`)
}

/** Render a dim tool-activity line. */
function printTool(io: TuiIo, name: string): void {
  io.stdout.write(`${ANSI.dim}⏱ ${name}${ANSI.reset}\n`)
}

/**
 * Run the interactive REPL: if a seed task was provided, run it first, then
 * loop reading lines until the user exits.
 * @param ctx - plugin context carrying the Agent, default model, Session, and launcher IO services.
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

  // Enter the alternate screen for a full-surface TUI; guarantee restoration
  // even on abrupt exit (SIGINT/SIGTERM go through the launcher's handlers).
  io.stdout.write(ANSI.altEnter)
  process.on('exit', () => {
    process.stdout.write(ANSI.altLeave + ANSI.showCursor)
  })
  io.stdout.write(ANSI.clearScreen + ANSI.hideCursor)

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
  const header = `${ANSI.bold}DeepSeek Harness TUI${ANSI.reset} ${ANSI.dim}· ${selection.provider}/${selection.model} · session ${sessionId}${ANSI.reset}`
  io.stdout.write(header + '\n')
  io.stdout.write(`${ANSI.dim}/help for commands · /exit to quit${ANSI.reset}\n\n`)
  io.stdout.write(ANSI.showCursor)

  // Run the seed (if any) BEFORE opening readline, so an immediately-closed
  // stdin cannot abort the in-flight turn via the close handler.
  if (seed.trim() !== '') {
    printUser(io, seed)
    await runTurn(agent, io, sessions, seed, streaming, name => printTool(io, name))
    io.stdout.write('\n')
  }

  const rl: Interface = createInterface({
    input: process.stdin,
    // readline needs a full WritableStream; routing through process.stdout keeps
    // prompts echoing to the real terminal (the common output target).
    output: process.stdout,
  })
  let closed = false
  let pendingResolve: ((line: string) => void) | undefined
  // Do NOT exit from the close handler: stdin may close while a turn is still
  // running (piped input), and an immediate exit would abort the in-flight
  // agent turn. Flag it and settle any pending prompt so the loop can leave
  // cleanly between turns (readline never fires a pending question callback
  // once the interface closes, so we resolve it ourselves).
  rl.on('close', () => {
    closed = true
    pendingResolve?.('')
    pendingResolve = undefined
  })
  const ask = (query: string): Promise<string> => new Promise((resolve) => {
    if (closed) return resolve('')
    pendingResolve = resolve
    rl.question(query, (line) => {
      pendingResolve = undefined
      resolve(line)
    })
  })

  const quit = async (): Promise<void> => {
    // Fire-and-forget durability flush: never let it block leaving the REPL.
    void sessions.flush(agent.session).catch(() => {})
    io.stdout.write(ANSI.altLeave + ANSI.showCursor + '\n')
    io.exit(0)
  }

  const loop = async (): Promise<void> => {
    for (;;) {
      const line = (await ask('dsh> ')).trim()
      if (closed) {
        await quit()
        return
      }
      if (line === '') continue
      const lower = line.toLowerCase()
      if (lower === 'q' || lower === 'quit' || lower === ':q' || lower === '/exit' || lower === '/quit') {
        await quit()
        return
      }
      if (lower === '/help' || lower === '?') {
        io.stdout.write(`${ANSI.dim}commands: /help /clear /model /status /stream on|off /exit — or q / quit / :q${ANSI.reset}\n`)
        continue
      }
      if (lower === '/clear' || lower === 'clear') {
        io.stdout.write(ANSI.clearScreen)
        continue
      }
      if (lower === '/model') {
        io.stdout.write(`${ANSI.dim}model: ${selection.provider}/${selection.model}${ANSI.reset}\n`)
        continue
      }
      if (lower === '/status') {
        io.stdout.write(`${ANSI.dim}session: ${sessionId} · cwd: ${process.cwd()} · events: ${agent.session.events.length}${ANSI.reset}\n`)
        continue
      }
      if (lower.startsWith('/stream')) {
        const arg = lower.split(/\s+/)[1]
        if (arg === 'on' || arg === 'off') {
          streaming = arg === 'on'
          io.stdout.write(`${ANSI.dim}streaming: ${streaming ? 'on' : 'off'}${ANSI.reset}\n`)
        } else {
          io.stdout.write(`${ANSI.dim}usage: /stream on|off (current: ${streaming ? 'on' : 'off'})${ANSI.reset}\n`)
        }
        continue
      }
      if (lower.startsWith('/')) {
        io.stdout.write(`${ANSI.red}unknown command: ${line}${ANSI.reset}\n`)
        continue
      }
      printUser(io, line)
      await runTurn(agent, io, sessions, line, streaming, name => printTool(io, name))
      io.stdout.write('\n')
      if (closed) {
        await quit()
        return
      }
    }
  }

  void loop()
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
  const io: TuiIo = { stdout: internals.stdout, stderr: internals.stderr, exit }
  void run(ctx, io, config.task, config.streaming).catch((error: unknown) => {
    io.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`)
    io.exit(1)
  })
}
