/**
 * @deepseek-ai/dsh-tui-app — interactive terminal REPL. The bundle patch rides
 * over dsh-base without Host, HTTP, or browser plugins; this runner creates
 * one Agent through the core registry and drives a full-screen
 * Claude Code / opencode-style surface (see ./ui.ts): conversation scrollback,
 * fixed input bar with prompt history and slash-command completion, status
 * bar, live token streaming, reasoning blocks, and tool-call cards.
 *
 * Slash commands:
 *   /help /exit /quit /clear /status
 *   /model [id] [effort]   list models and reasoning efforts; switch live
 *   /resume [n|id]         list persisted sessions; continue one
 *   /compact               compact the conversation now
 *   /reasoning on|off      show or hide the thinking display
 *   /stream on|off         toggle live token streaming
 *
 * @module @deepseek-ai/dsh-tui-app
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-plan-mode'
import { Tui, type TuiCommand } from './ui.ts'
// Empty type imports carry the loader Context merge for the settlement await
// and the cmdline Context merge for the appExit host value.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'tui-runner'

/** Core services required before the interactive turn can start. */
export const inject = ['agentDefaultModel', 'agents', 'sessions', 'sessionQuery', 'compaction', 'permissionPresets', 'planMode']

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
 */
async function runTurn(
  agent: TuiAgent,
  ui: Tui,
  sessions: { flush(session: unknown): Promise<unknown> },
  prompt: string,
  streaming: boolean,
): Promise<void> {
  const firstSeq = agent.session.seq
  const startedAt = Date.now()
  const tokensBefore = ui.tokens()
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
  const tokensAfter = ui.tokens()
  ui.append({
    kind: 'separator',
    text: '',
    meta: {
      time: new Date().toISOString().slice(11, 19),
      seconds: Math.round((Date.now() - startedAt) / 1000),
      tokensIn: tokensAfter.in - tokensBefore.in,
      tokensOut: tokensAfter.out - tokensBefore.out,
    },
  })
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

/** One catalog entry for the /model picker. */
interface CatalogModel {
  provider: string
  providerName: string
  id: string
  name: string
  description?: string
  efforts: string[]
  defaultEffort?: string
}

/** One entry for the /resume picker. */
interface SessionPick {
  id: string
  title: string
  createdAt: string
  live: boolean
}

/**
 * Run the interactive REPL through the full-screen surface.
 */
async function run(ctx: Context, io: TuiIo, seed: string, streaming: boolean): Promise<void> {
  // Loader siblings mount concurrently. Await the complete application before
  // creating an Agent so its scoped tools and adapters are not half-composed.
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  const sessionQuery = ctx.get('sessionQuery')
  const compaction = ctx.get('compaction')
  const llm = ctx.get('llm')
  const permissionPresets = ctx.get('permissionPresets')
  const planMode = ctx.get('planMode')
  // Early process shutdown can dispose the tree while settlement is pending.
  if (agents === undefined || defaultModel === undefined || sessions === undefined) return
  // Capture narrowed services so hoisted closures below keep them defined.
  const agentsSvc = agents
  const defaultModelSvc = defaultModel
  const sessionsSvc = sessions

  const selection = defaultModelSvc.currentSelection()
  // Shared mutable selection: every agent (boot and resumed) reads it per
  // request, so /model switches apply to the very next turn, live.
  const selected: ModelSelectionRef = { current: selection, assembled: undefined }

  const createHandle = await agentsSvc.create({
    sessionId: SessionId(`session-${randomUUID()}`),
    meta: { cwd: process.cwd() },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: (agentCtx) => {
      installModelSelection(agentCtx, selected)
    },
  })
  await createHandle.agent.whenIdle()

  // The active agent (mutable across /resume) and its disposer.
  let activeAgent: TuiAgent = createHandle.agent as unknown as TuiAgent
  let disposeActive: (() => void) | undefined = () => createHandle.dispose()

  // Caches for the /resume and /model pickers (indexes map into these).
  let sessionPicks: SessionPick[] = []
  let catalog: CatalogModel[] = []

  const cwd = process.cwd()
  const headerText = (): string => {
    const sel = selected.current ?? selection
    return `${sel.provider}/${sel.model} · session ${activeSessionShort()}`
  }
  const activeSessionShort = (): string => (activeAgent.session.id ?? '?').replace(/^session-/, '').slice(0, 8)
  const status = (): string => `${cwd} · ${streaming ? 'stream on' : 'stream off'}${turnCount > 0 ? ` · ${turnCount} turns` : ''}`

  // ── /model ────────────────────────────────────────────────────────────────

  async function buildCatalog(): Promise<CatalogModel[]> {
    const result: CatalogModel[] = []
    const providers = llm?.listProviders() ?? []
    for (const provider of providers) {
      let models
      try {
        models = await llm?.listModels(provider.id)
      } catch {
        continue
      }
      for (const model of models ?? []) {
        let resolved
        try {
          resolved = await llm?.resolveModelInfo(provider.id, model.id)
        } catch {
          resolved = undefined
        }
        result.push({
          provider: provider.id,
          providerName: provider.name ?? provider.id,
          id: model.id,
          name: model.name ?? model.id,
          ...(model.description !== undefined && { description: model.description }),
          efforts: (resolved?.reasoning?.efforts ?? []).map(effort => String(effort.id)),
          ...(resolved?.reasoning?.defaultEffort !== undefined && { defaultEffort: String(resolved.reasoning.defaultEffort) }),
        })
      }
    }
    return result
  }

  async function modelCommand(args: string): Promise<void> {
    if (args.trim() === '') {
      ui.append({ kind: 'system', text: 'loading model catalog…' })
      catalog = await buildCatalog()
      if (catalog.length === 0) {
        ui.append({ kind: 'error', text: 'no models discovered (is the llm adapter mounted?)' })
        return
      }
      const current = selected.current
      for (const m of catalog) {
        const mark = current !== undefined && m.provider === current.provider && m.id === current.model ? ' ● active' : ''
        const efforts = m.efforts.length > 0 ? ` [reasoning: ${m.efforts.join('/')}]` : ''
        ui.append({ kind: 'system', text: `${m.id}  (${m.providerName})${efforts}${mark}` })
      }
      ui.append({ kind: 'system', text: 'usage: /model <id> — switch now; /model <id> <effort> — switch + set reasoning effort' })
      return
    }
    const [modelArg, effortArg] = args.split(/\s+/)
    if (catalog.length === 0) catalog = await buildCatalog()
    const found = catalog.find(m => m.id === modelArg)
    if (found === undefined) {
      ui.append({ kind: 'error', text: `model ${modelArg} not found — run /model to list available models` })
      return
    }
    const next: ModelSelection = effortArg !== undefined
      ? {
        provider: found.provider,
        model: found.id,
        reasoningEffort: ReasoningEffortId(effortArg.toLowerCase()),
      }
      : { provider: found.provider, model: found.id }
    if (effortArg !== undefined && !found.efforts.includes(effortArg.toLowerCase())) {
      ui.append({ kind: 'error', text: `effort ${effortArg} not advertised for ${found.id} (available: ${found.efforts.join('/') || 'unknown'})` })
    }
    selected.current = next
    // Persist as the default for future sessions.
    try {
      await defaultModelSvc.saveSelection(next)
    } catch {
      // Non-fatal: the live switch already took effect.
    }
    ui.append({ kind: 'system', text: `model → ${found.id}${next.reasoningEffort !== undefined ? ` (reasoning ${next.reasoningEffort})` : ''}` })
    ui.setHeader(headerText())
  }

  // ── /resume ───────────────────────────────────────────────────────────────

  async function resumeCommand(args: string): Promise<void> {
    if (sessionQuery === undefined) {
      ui.append({ kind: 'error', text: 'session browsing is not mounted in this profile' })
      return
    }
    const target = args.trim()
    if (target === '') {
      ui.append({ kind: 'system', text: 'loading sessions…' })
      const records = await sessionQuery.listSessions()
      const sorted = [...records].sort((a, b) => b.header.createdAt - a.header.createdAt)
      sessionPicks = []
      for (const record of sorted.slice(0, 15)) {
        const title = (await sessionQuery.readTitle(record.header.id).catch(() => undefined))?.title ?? '(untitled)'
        const date = new Date(record.header.createdAt).toISOString().slice(0, 16).replace('T', ' ')
        sessionPicks.push({ id: record.header.id, title, createdAt: date, live: record.live })
      }
      if (sessionPicks.length === 0) {
        ui.append({ kind: 'system', text: 'no persisted sessions found' })
        return
      }
      sessionPicks.forEach((pick, i) => {
        const mark = pick.live ? ' ● live' : ''
        ui.append({ kind: 'system', text: `${String(i + 1).padStart(2)}  ${pick.createdAt}  ${pick.id.replace(/^session-/, '').slice(0, 8)}  ${pick.title}${mark}` })
      })
      ui.append({ kind: 'system', text: 'usage: /resume <number> — continue that session' })
      return
    }
    if (sessionPicks.length === 0) {
      ui.append({ kind: 'error', text: 'run /resume first to list sessions, then /resume <number>' })
      return
    }
    const pick = /^\d+$/.test(target)
      ? sessionPicks[Number(target) - 1]
      : sessionPicks.find(p => p.id.startsWith(target) || p.id.includes(target))
    if (pick === undefined) {
      ui.append({ kind: 'error', text: `no session matches ${target}` })
      return
    }
    ui.append({ kind: 'system', text: `resuming session ${pick.id.replace(/^session-/, '').slice(0, 8)}…` })
    try {
      const handle = await agentsSvc.resume({
        resumeSessionId: SessionId(pick.id),
        ...(selected.current !== undefined && {
          agentOptions: { provider: selected.current.provider, model: selected.current.model },
        }),
        setup: (agentCtx) => {
          installModelSelection(agentCtx, selected)
        },
      })
      await handle.agent.whenIdle()
      await sessionsSvc.flush(activeAgent.session as never)
      disposeActive?.()
      disposeActive = () => handle.dispose()
      activeAgent = handle.agent as unknown as TuiAgent
      ui.append({ kind: 'system', text: `resumed ${pick.id.replace(/^session-/, '').slice(0, 8)} — ${pick.title}` })
      ui.setHeader(headerText())
    } catch (error) {
      ui.append({ kind: 'error', text: `resume failed: ${error instanceof Error ? error.message : String(error)}` })
    }
  }

  // ── /compact ──────────────────────────────────────────────────────────────

  async function compactCommand(): Promise<void> {
    if (compaction === undefined) {
      ui.append({ kind: 'error', text: 'compaction is not mounted in this profile' })
      return
    }
    ui.append({ kind: 'system', text: 'compacting conversation…' })
    try {
      const result = await compaction.compactNow(activeAgent as never, new AbortController().signal)
      if (result === null) {
        ui.append({ kind: 'system', text: 'nothing to compact (history too short)' })
        return
      }
      ui.append({ kind: 'system', text: `compacted: ${result.shadowedSeqs.length} events shadowed (~${result.shadowedTokenCount} tokens)` })
    } catch (error) {
      const code = (error as { code?: string }).code
      ui.append({ kind: 'error', text: `compact failed${code !== undefined ? ` (${code})` : ''}: ${error instanceof Error ? error.message : String(error)}` })
    }
  }

  // ── command table ─────────────────────────────────────────────────────────

  let showReasoning = true
  let turnCount = 0

  /** The three permission presets shipped by the base bundle. */
  const PRESETS: Array<{ name: string; sandbox: string; approval: string; description: string }> = [
    { name: 'read-only', sandbox: 'read-only', approval: 'ask', description: 'Read files only; writes require approval' },
    { name: 'workspace-write', sandbox: 'workspace-write', approval: 'ask', description: 'Write inside the workspace; wider access needs approval' },
    { name: 'danger-full-access', sandbox: 'danger-full-access', approval: 'never', description: 'Full file access without prompts' },
  ]

  async function permissionsCommand(args: string): Promise<void> {
    if (permissionPresets === undefined) {
      ui.append({ kind: 'error', text: 'permission presets are not mounted in this profile' })
      return
    }
    const name = args.trim().toLowerCase()
    if (name === '') {
      const current = permissionPresets.current(activeAgent.session.events as never)
      for (const preset of PRESETS) {
        const mark = current === preset.name ? ' ● active' : ''
        ui.append({ kind: 'system', text: `${preset.name}  [sandbox: ${preset.sandbox}, approval: ${preset.approval}] — ${preset.description}${mark}` })
      }
      ui.append({ kind: 'system', text: 'usage: /permissions <name> — switch the current session' })
      return
    }
    if (!PRESETS.some(p => p.name === name)) {
      ui.append({ kind: 'error', text: `unknown preset ${name} (available: ${PRESETS.map(p => p.name).join(', ')})` })
      return
    }
    try {
      permissionPresets.set(activeAgent.session as never, name)
      ui.append({ kind: 'system', text: `permissions → ${name}` })
    } catch (error) {
      ui.append({ kind: 'error', text: `permissions failed: ${error instanceof Error ? error.message : String(error)}` })
    }
  }

  async function planCommand(): Promise<void> {
    if (planMode === undefined) {
      ui.append({ kind: 'error', text: 'plan mode is not mounted in this profile' })
      return
    }
    const state = planMode.get(activeAgent as never)
    const outcome = planMode.set(activeAgent as never, !state.active)
    const next = planMode.get(activeAgent as never)
    ui.append({ kind: 'system', text: `plan mode: ${next.active ? 'on' : 'off'}${next.pending === true ? ' (queued for next step)' : ''} [${outcome}]` })
  }

  async function trajectoryCommand(): Promise<void> {
    const events = activeAgent.session.events
    const recent = events.slice(-60)
    if (recent.length === 0) {
      ui.append({ kind: 'system', text: 'no events in this session yet' })
      return
    }
    ui.append({ kind: 'system', text: `trajectory (last ${recent.length} of ${events.length} events):` })
    for (const event of recent) {
      const summary = trajectoryLine(event)
      if (summary !== undefined) ui.append({ kind: 'system', text: summary })
    }
  }

  /** Compact one-line summary of a session event for /trajectory. */
  function trajectoryLine(event: SessionEvent): string | undefined {
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
      case 'user/message': return `${seq}  ❯ ${textOf(data)}`
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

  const commands: TuiCommand[] = [
    {
      name: 'help',
      usage: '',
      help: 'show this help',
      handler: () => ui.append({ kind: 'system', text: 'commands: /help /clear /model /resume /compact /permissions /plan /trajectory /status /reasoning on|off /stream on|off /exit — or q / quit / :q' }),
    },
    { name: 'clear', usage: '', help: 'clear the conversation area', handler: () => ui.clearLog() },
    { name: 'model', usage: '[id] [effort]', help: 'list models + reasoning efforts; switch live', handler: args => void modelCommand(args) },
    { name: 'resume', usage: '[n]', help: 'list persisted sessions; continue one', handler: args => void resumeCommand(args) },
    { name: 'compact', usage: '', help: 'compact the conversation now', handler: () => void compactCommand() },
    { name: 'permissions', usage: '[name]', help: 'list/switch read-only, workspace-write, full access', handler: args => void permissionsCommand(args) },
    { name: 'plan', usage: '', help: 'toggle plan mode (next step)', handler: () => void planCommand() },
    { name: 'trajectory', usage: '', help: 'show the session event timeline', handler: () => void trajectoryCommand() },
    { name: 'status', usage: '', help: 'show session and workspace info', handler: () => ui.append({ kind: 'system', text: `session: ${activeAgent.session.id} · cwd: ${process.cwd()} · events: ${activeAgent.session.events.length} · turns: ${turnCount}` }) },
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
          ui.setStatus(status())
        } else {
          ui.append({ kind: 'system', text: `usage: /stream on|off (current: ${streaming ? 'on' : 'off'})` })
        }
      },
    },
    { name: 'exit', usage: '', help: 'leave the session', handler: () => ui.requestExit() },
    { name: 'quit', usage: '', help: 'leave the session', handler: () => ui.requestExit() },
  ]

  const ui = new Tui({
    commands,
    header: headerText(),
    status: status(),
    onPrompt: (line) => {
      void (async () => {
        ui.append({ kind: 'user', text: line })
        ui.setBusy(true)
        try {
          await runTurn(activeAgent, ui, sessions, line, streaming)
          turnCount += 1
          ui.setStatus(status())
        } finally {
          ui.setBusy(false)
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
