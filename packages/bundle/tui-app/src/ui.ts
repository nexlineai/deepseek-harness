/**
 * Terminal UI surface for @deepseek-ai/dsh-tui-app.
 *
 * A Claude Code / opencode-style full-screen layout rendered with raw ANSI:
 *
 *   ┌ DeepSeek Harness TUI          model · /Users/zdb/deepseek-harness ┐  header
 *   │ ────────────────────────────────────────────────────────── · 12s ┐│  separator (turn meta)
 *   │ ❯ count to 3                                                    │  user (bold, cyan prefix)
 *   │ ✻ thinking                                                      │  reasoning (dim italic)
 *   │   · the sequence is trivial; I can answer directly              │
 *   │ 1, 2, 3.                                                       │  assistant (markdown)
 *   │ ┌── ⏱ bash ──────────────────────────────────────────────────┐ │
 *   │ │ $ ls -la                                                     │ │  tool block
 *   │ └── ✓ done ───────────────────────────────────────────────────┘ │
 *   │ ❯ input line (single row, horizontal scroll)                    │  input
 *   │ model · a1b2c3d4 · stream on · 12→45 tok        ↑ scrolled ⠋  │  status bar
 *
 * Interaction (raw mode on a TTY): arrows walk history, Home/End,
 * Ctrl+A/E, Backspace/Delete, Ctrl+U/K/W line editing, Tab completes slash
 * commands, Esc clears input, Enter submits, Ctrl+C clears (empty → exit),
 * Ctrl+D exits, PgUp/PgDn/Home/End scroll the conversation backbuffer.
 * Non-TTY stdin (pipes) falls back to plain line reads.
 *
 * Rendering notes: wrapping is ANSI-aware and word-boundary based; assistant
 * and reasoning text gets lightweight markdown styling (fenced code blocks,
 * inline code, bold, headings, lists); tool calls render as full-width
 * box-drawn blocks with lifecycle markers; turn separators carry elapsed time
 * and token deltas.
 *
 * @module @deepseek-ai/dsh-tui-app/ui
 */

import { createInterface, type Interface } from 'node:readline'
import { StringDecoder } from 'node:string_decoder'

/** One conversation log entry. */
export interface TuiEntry {
  kind: 'user' | 'assistant' | 'reasoning' | 'tool' | 'error' | 'system' | 'separator'
  text: string
  /** Tool name (kind 'tool'). */
  name?: string
  /** Tool lifecycle marker. */
  status?: 'running' | 'done' | 'error'
  /** Tool args / output preview lines. */
  detail?: string
  /** Turn statistics (kind 'separator'). */
  meta?: { seconds: number; tokensIn: number; tokensOut: number }
}

/** Commands the UI knows about for / completion and help. */
export interface TuiCommand {
  name: string
  usage: string
  help: string
  /** Optional driver-provided handler; without one the UI prints usage. */
  handler?: (args: string) => void
}

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  inverse: '\x1b[7m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  grey: '\x1b[90m',
  clearScreen: '\x1b[2J\x1b[H',
  home: '\x1b[H',
  altEnter: '\x1b[?1049h',
  altLeave: '\x1b[?1049l',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  cursorAt: (row: number, col: number): string => `\x1b[${row};${col}H`,
  eraseLine: '\x1b[2K',
} as const

const BOX = {
  tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│',
} as const

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** Visible width of a string, ignoring ANSI escape sequences. */
function width(text: string): number {
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').length
}

/** Pad `text` with spaces so its ANSI-free width is `w`. */
function padRight(text: string, w: number): string {
  const missing = w - width(text)
  return missing > 0 ? text + ' '.repeat(missing) : text
}

/** Word-boundary wrap (hard-break long words), ANSI-free input. */
function wrapWords(text: string, cols: number): string[] {
  if (cols <= 0) return [text]
  const lines: string[] = []
  for (const raw of text.split('\n')) {
    if (raw === '') {
      lines.push('')
      continue
    }
    let line = ''
    for (const word of raw.split(/(?<=\s)/)) {
      const candidate = line + word
      if (width(candidate) > cols && line.trim() !== '') {
        lines.push(line.trimEnd())
        line = word.trimStart()
        // Hard-break overlong words.
        while (width(line) > cols) {
          lines.push(line.slice(0, cols))
          line = line.slice(cols)
        }
      } else {
        line = candidate
      }
    }
    lines.push(line.trimEnd())
  }
  return lines
}

/** A pre-styled log row with its plain width. */
interface LogRow {
  text: string
  w: number
}

// ── markdown styling ────────────────────────────────────────────────────────

/** Strip markdown syntax for width math. */
function mdPlain(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '  ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^>\s*/gm, '')
}

/** Style one already-wrapped plain line with inline markdown. */
function styleMdLine(line: string): string {
  let out = line
  // Bold **text** / __text__.
  out = out.replace(/\*\*([^*]+)\*\*/g, `${ANSI.bold}$1${ANSI.reset}`)
  out = out.replace(/__([^_]+)__/g, `${ANSI.bold}$1${ANSI.reset}`)
  // Inline `code`.
  out = out.replace(/`([^`]+)`/g, `${ANSI.cyan}$1${ANSI.reset}`)
  // Italic *text*.
  out = out.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, `$1${ANSI.italic}$2${ANSI.reset}`)
  // Links [text](url) → text.
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, `${ANSI.blue}$1${ANSI.reset}`)
  // Headings.
  if (/^#{1,6}\s/.test(out)) {
    out = `${ANSI.bold}${ANSI.yellow}${out.replace(/^#{1,6}\s*/, '')}${ANSI.reset}`
  }
  // Blockquotes.
  if (/^>\s/.test(out)) {
    out = `${ANSI.grey}${out.replace(/^>\s*/, '│ ')}${ANSI.reset}`
  }
  // List markers get a colored bullet.
  out = out.replace(/^(\s*)([-*])\s/, `$1${ANSI.cyan}$2${ANSI.reset} `)
  return out
}

/** Render markdown-ish text into styled rows of width `cols`. */
function styleMarkdown(text: string, cols: number): LogRow[] {
  const rows: LogRow[] = []
  // Fenced code blocks first: split into segments.
  const parts = text.split(/```/)
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      // Code block: grey box with hard-wrapped content.
      const inner = Math.max(1, cols - 4)
      let content = part.replace(/^\s*\n/, '').replace(/\n$/, '')
      // Strip a leading language tag line (```bash → bash).
      if (/^[a-zA-Z0-9_+.-]*$/.test(content.split('\n')[0] ?? '') && content.includes('\n')) {
        content = content.slice(content.indexOf('\n') + 1)
      }
      const codeLines = wrapWords(content, inner)
      rows.push({ text: `${ANSI.grey}${BOX.tl}${BOX.h.repeat(cols - 2)}${BOX.tr}${ANSI.reset}`, w: cols })
      for (const codeLine of codeLines) {
        rows.push({ text: `${ANSI.grey}${BOX.v}${ANSI.reset} ${codeLine}${' '.repeat(Math.max(0, inner - width(codeLine)))}${ANSI.grey}${BOX.v}${ANSI.reset}`, w: cols })
      }
      rows.push({ text: `${ANSI.grey}${BOX.bl}${BOX.h.repeat(cols - 2)}${BOX.br}${ANSI.reset}`, w: cols })
      return
    }
    if (part === '') return
    for (const line of wrapWords(mdPlain(part), cols - 2)) {
      const styled = styleMdLine(line)
      rows.push({ text: styled, w: width(styled) })
    }
  })
  return rows
}

/**
 * The full-screen surface. Owns raw-mode input, rendering, prompt history,
 * slash-command completion, streaming "pending" assistant/reasoning lines,
 * tool blocks, a busy spinner, token counters, and conversation scrollback.
 * The driver (index.ts) supplies callbacks for submitted prompts and exit
 * requests and drives turns by appending entries / stream chunks / tool
 * results.
 */
export class Tui {
  private readonly commands: TuiCommand[]
  private readonly onPrompt: (line: string) => void
  private readonly onExit: () => void

  private entries: TuiEntry[] = []
  private pendingText = ''
  private pendingReasoning = ''
  private headerText = ''
  private statusText = ''
  private buffer = ''
  private cursor = 0
  private history: string[] = []
  private historyIndex = 0
  private exited = false

  private tty: boolean
  private rl: Interface | undefined
  private raw: NodeJS.ReadStream | undefined
  private renderQueued = false
  private resizeListener: (() => void) | undefined

  // Busy state: spinner + status redraw only.
  private busy = false
  private spinnerFrame = 0
  private spinnerTimer: ReturnType<typeof setInterval> | undefined

  // Token accounting for the status bar.
  private tokensIn = 0
  private tokensOut = 0
  private tokensReasoning = 0

  // Conversation scrollback (0 = bottom).
  private scroll = 0

  /** Whether reasoning is currently rendered. */
  private showReasoning = true

  constructor(opts: {
    commands: TuiCommand[]
    onPrompt: (line: string) => void
    onExit: () => void
    header: string
    status: string
  }) {
    this.commands = opts.commands
    this.onPrompt = opts.onPrompt
    this.onExit = opts.onExit
    this.headerText = opts.header
    this.statusText = opts.status
    this.tty = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  }

  /** Enter the alternate screen and start reading input. */
  start(): void {
    if (this.exited) return
    process.stdout.write(ANSI.altEnter + ANSI.clearScreen)
    process.on('exit', () => this.restore())
    this.resizeListener = () => this.render()
    process.stdout.on('resize', this.resizeListener)
    if (this.tty) {
      process.stdin.setRawMode(true)
      process.stdin.resume()
      this.raw = process.stdin
      process.stdin.on('data', (buf: Buffer) => this.onData(buf))
    } else {
      // Piped stdin (tests, scripts): plain line reads, no editing surface.
      this.rl = createInterface({ input: process.stdin, output: process.stdout })
      this.rl.on('line', line => this.submit(line.trim()))
      this.rl.on('close', () => this.requestExit())
    }
    this.render()
  }

  /** Leave the alternate screen and restore the terminal. */
  restore(): void {
    process.stdout.write(ANSI.altLeave + ANSI.showCursor)
  }

  /** Append a conversation entry, snap scrollback to the bottom, and redraw. */
  append(entry: TuiEntry): void {
    if (this.exited) return
    if (entry.kind === 'assistant') this.pushPending()
    this.entries.push(entry)
    if (this.scroll > 0 && entry.kind !== 'separator') this.scroll = 0
    this.render()
  }

  /** Begin a streaming response: clear pending assistant + reasoning lines. */
  beginStreaming(): void {
    this.pushPending()
    this.pendingText = ''
    this.pendingReasoning = ''
  }

  /** Render one delta into the streaming lines (text or reasoning). */
  streamChunk(text: string, reasoning = false): void {
    if (reasoning) this.pendingReasoning += text
    else this.pendingText += text
    this.queueRender()
  }

  /** End the streaming lines; finalize them into the log. */
  endStreaming(): void {
    this.pushPending()
  }

  /** Set the header right-side text (model, session). */
  setHeader(text: string): void {
    this.headerText = text
    this.render()
  }

  /** Set the status-bar base text (cwd, streaming state, ...). */
  setStatus(text: string): void {
    this.statusText = text
    this.render()
  }

  /** Toggle the busy spinner (a turn is in flight). */
  setBusy(busy: boolean): void {
    this.busy = busy
    if (busy) {
      this.spinnerFrame = 0
      this.spinnerTimer ??= setInterval(() => {
        this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER.length
        this.renderStatusLine()
      }, 100)
    } else if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer)
      this.spinnerTimer = undefined
      this.render()
    }
  }

  /** Toggle reasoning display. */
  setShowReasoning(show: boolean): void {
    this.showReasoning = show
    this.render()
  }

  /** Accumulate token usage for the status bar. */
  addTokens(usage: { inputTokens: number; outputTokens: number; reasoningTokens?: number }): void {
    this.tokensIn += usage.inputTokens
    this.tokensOut += usage.outputTokens
    this.tokensReasoning += usage.reasoningTokens ?? 0
    this.render()
  }

  /** Current token totals (for per-turn separator stats). */
  tokens(): { in: number; out: number } {
    return { in: this.tokensIn, out: this.tokensOut }
  }

  /** Update the most recent tool entry's lifecycle state. */
  updateLastTool(status: 'done' | 'error', detail?: string): void {
    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      const entry = this.entries[i]
      if (entry !== undefined && entry.kind === 'tool') {
        entry.status = status
        if (detail !== undefined && detail !== '') entry.detail = detail
        break
      }
    }
    this.render()
  }

  /** Clear all conversation entries (e.g. /clear). */
  clearLog(): void {
    this.entries = []
    this.pendingText = ''
    this.pendingReasoning = ''
    this.scroll = 0
    this.render()
  }

  /** Submit a prompt programmatically (e.g. the boot-time seed task). */
  submit(line: string): void {
    if (this.exited || line === '') return
    if (line.startsWith('/')) {
      this.handleCommand(line)
    } else {
      this.history.push(line)
      this.historyIndex = this.history.length
      this.onPrompt(line)
    }
  }

  /** Request exit; safe to call repeatedly. */
  requestExit(): void {
    if (this.exited) return
    this.exited = true
    this.rl?.close()
    if (this.raw) {
      this.raw.removeAllListeners('data')
      try {
        process.stdin.setRawMode(false)
      } catch {
        // non-TTY or already released; ignore
      }
    }
    if (this.resizeListener) process.stdout.off('resize', this.resizeListener)
    if (this.spinnerTimer) clearInterval(this.spinnerTimer)
    this.onExit()
  }

  // ── input handling ────────────────────────────────────────────────────────

  private pendingEsc = ''
  private decoder = new StringDecoder('utf8')

  private onData(buf: Buffer): void {
    // Decode UTF-8 first so multibyte input (❯, emoji, accents) survives.
    const text = this.decoder.write(buf)
    for (const char of text) {
      if (this.pendingEsc !== '') {
        this.pendingEsc += char
        if (/[A-Za-z~]/.test(char)) {
          const seq = this.pendingEsc
          this.pendingEsc = ''
          this.onEscape(seq)
        }
        continue
      }
      if (char === '\x1b') {
        this.pendingEsc = '\x1b'
        continue
      }
      this.onChar(char)
    }
  }

  private onEscape(seq: string): void {
    if (seq === '\x1b') {
      // Esc alone: clear the input line.
      this.buffer = ''
      this.cursor = 0
      this.render()
      return
    }
    const code = seq.slice(2) // strip ESC [
    if (code === 'A') this.historyPrev()
    else if (code === 'B') this.historyNext()
    else if (code === 'C') this.cursor = Math.min(this.cursor + 1, this.buffer.length)
    else if (code === 'D') this.cursor = Math.max(this.cursor - 1, 0)
    else if (code === 'H' || code === '1~') this.cursor = 0
    else if (code === 'F' || code === '4~') this.cursor = this.buffer.length
    else if (code === '3~') this.deleteAt(this.cursor)
    else if (code === '5~') this.scrollPage(1)
    else if (code === '6~') this.scrollPage(-1)
    this.render()
  }

  private insertChar(char: string): void {
    this.buffer = this.buffer.slice(0, this.cursor) + char + this.buffer.slice(this.cursor)
    this.cursor += char.length
    this.scroll = 0
    this.render()
  }

  private onChar(char: string): void {
    if (char === '\r' || char === '\n') {
      // Enter: submit.
      const line = this.buffer
      this.buffer = ''
      this.cursor = 0
      this.render()
      this.submit(line.trim())
      return
    }
    if (char === '\x03') {
      // Ctrl+C: clear the buffer; second press exits.
      if (this.buffer === '') this.requestExit()
      else {
        this.buffer = ''
        this.cursor = 0
        this.render()
      }
      return
    }
    if (char === '\x04') {
      // Ctrl+D: exit.
      this.requestExit()
      return
    }
    if (char === '\t') {
      this.completeCommand()
      return
    }
    if (char === '\x01') {
      // Ctrl+A: start of line.
      this.cursor = 0
      this.render()
      return
    }
    if (char === '\x05') {
      // Ctrl+E: end of line.
      this.cursor = this.buffer.length
      this.render()
      return
    }
    if (char === '\x15') {
      // Ctrl+U: kill to start.
      this.buffer = this.buffer.slice(this.cursor)
      this.cursor = 0
      this.render()
      return
    }
    if (char === '\x0b') {
      // Ctrl+K: kill to end.
      this.buffer = this.buffer.slice(0, this.cursor)
      this.render()
      return
    }
    if (char === '\x17') {
      // Ctrl+W: delete previous word.
      const before = this.buffer.slice(0, this.cursor)
      const cut = before.replace(/\S+\s*$/, '')
      this.buffer = cut + this.buffer.slice(this.cursor)
      this.cursor = cut.length
      this.render()
      return
    }
    if (char === '\x7f' || char === '\b') {
      this.deleteAt(this.cursor - 1)
      this.render()
      return
    }
    if (char >= ' ') {
      this.insertChar(char)
    }
  }

  private deleteAt(pos: number): void {
    if (pos < 0 || pos >= this.buffer.length) return
    this.buffer = this.buffer.slice(0, pos) + this.buffer.slice(pos + 1)
    if (this.cursor > pos) this.cursor -= 1
  }

  private historyPrev(): void {
    if (this.history.length === 0) return
    if (this.historyIndex > 0) this.historyIndex -= 1
    this.buffer = this.history[this.historyIndex] ?? ''
    this.cursor = this.buffer.length
    this.scroll = 0
  }

  private historyNext(): void {
    if (this.historyIndex < this.history.length) this.historyIndex += 1
    this.buffer = this.history[this.historyIndex] ?? ''
    this.cursor = this.buffer.length
    this.scroll = 0
  }

  private scrollPage(dir: 1 | -1): void {
    const { rows } = this.dims()
    const page = Math.max(1, rows - 4)
    this.scroll = Math.max(0, this.scroll + dir * page)
    this.render()
  }

  private completeCommand(): void {
    if (!this.buffer.startsWith('/')) return
    const match = this.commands.find(c => c.name.startsWith(this.buffer.slice(1).toLowerCase()))
    if (match) {
      this.buffer = `/${match.name} `
      this.cursor = this.buffer.length
      this.render()
    }
  }

  private handleCommand(line: string): void {
    const parts = line.split(/\s+/)
    const raw = parts[0] ?? ''
    const args = parts.slice(1).join(' ')
    const name = raw.slice(1).toLowerCase()
    const cmd = this.commands.find(c => c.name === name)
    if (!cmd) {
      this.append({ kind: 'error', text: `unknown command: ${line}` })
      return
    }
    if (cmd.name === 'exit' || cmd.name === 'quit') {
      this.requestExit()
      return
    }
    if (cmd.handler) {
      cmd.handler(args)
    } else {
      this.append({ kind: 'system', text: `${ANSI.bold}/${cmd.name}${ANSI.reset} ${cmd.usage} — ${cmd.help}` })
    }
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  private pushPending(): void {
    // Reasoning streams first, so it must finalize BEFORE the answer text.
    if (this.pendingReasoning !== '' && this.showReasoning) {
      this.entries.push({ kind: 'reasoning', text: this.pendingReasoning })
      this.pendingReasoning = ''
    }
    if (this.pendingText !== '') {
      this.entries.push({ kind: 'assistant', text: this.pendingText })
      this.pendingText = ''
    }
  }

  private queueRender(): void {
    if (this.renderQueued) return
    this.renderQueued = true
    queueMicrotask(() => {
      this.renderQueued = false
      this.render()
    })
  }

  private dims(): { rows: number; cols: number } {
    return {
      rows: process.stdout.rows ?? 24,
      cols: process.stdout.columns ?? 80,
    }
  }

  /** Style one entry into ANSI-styled log rows. */
  private styleEntry(entry: TuiEntry, cols: number): LogRow[] {
    switch (entry.kind) {
      case 'user': {
        const rows: LogRow[] = []
        wrapWords(entry.text, cols - 2).forEach((line, i) => {
          const prefix = i === 0
            ? `${ANSI.cyan}${ANSI.bold}❯ ${ANSI.reset}`
            : '  '
          const text = `${prefix}${ANSI.bold}${line}${ANSI.reset}`
          rows.push({ text, w: width(text) })
        })
        return rows
      }
      case 'assistant':
        return styleMarkdown(entry.text, cols)
      case 'reasoning': {
        const rows: LogRow[] = []
        const head = `${ANSI.grey}${ANSI.bold}✻ thinking${ANSI.reset}`
        rows.push({ text: head, w: width(head) })
        for (const line of wrapWords(mdPlain(entry.text), cols - 4)) {
          const text = `${ANSI.grey}${ANSI.dim}${ANSI.italic}${styleMdLine(line)}${ANSI.reset}`
          rows.push({ text, w: width(text) })
        }
        return rows
      }
      case 'error':
        return wrapWords(entry.text, cols - 2).map((line) => {
          const text = `${ANSI.red}✖ ${line}${ANSI.reset}`
          return { text, w: width(text) }
        })
      case 'system':
        return wrapWords(entry.text, cols - 2).map((line) => {
          const text = `${ANSI.dim}${line}${ANSI.reset}`
          return { text, w: width(text) }
        })
      case 'separator':
        return [this.separatorRow(entry, cols)]
      case 'tool':
        return this.styleTool(entry, cols)
    }
  }

  private separatorRow(entry: TuiEntry, cols: number): LogRow {
    const meta = entry.meta
    const right = meta !== undefined
      ? ` ${meta.seconds}s · ${meta.tokensIn}→${meta.tokensOut} tok`
      : ''
    const lineLen = Math.max(1, cols - 2 - right.length)
    const text = `${ANSI.dim}${BOX.h.repeat(lineLen)}${right}${ANSI.reset}`
    return { text, w: width(text) }
  }

  /** Render a tool call as a full-width box-drawn block with lifecycle status. */
  private styleTool(entry: TuiEntry, cols: number): LogRow[] {
    const inner = Math.max(1, cols - 4)
    const title = `⏱ ${entry.name ?? 'tool'}`
    const statusMark = entry.status === 'done' ? `${ANSI.green}✓ done${ANSI.reset}`
      : entry.status === 'error' ? `${ANSI.red}✖ error${ANSI.reset}`
        : `${ANSI.yellow}● running${ANSI.reset}`
    const rows: LogRow[] = []
    // Top border: ┌─ title ───────────────┐
    rows.push({ text: `${ANSI.grey}${BOX.tl}${BOX.h} ${title}${ANSI.reset}${ANSI.grey}${' '.repeat(Math.max(0, inner - title.length - 1))}${BOX.h}${BOX.tr}${ANSI.reset}`, w: cols })
    const detailLines = wrapWords(entry.detail ?? '', inner)
    for (const detail of detailLines.slice(0, 5)) {
      rows.push({ text: `${ANSI.grey}${BOX.v}${ANSI.reset} ${padRight(detail, inner)}${ANSI.grey}${BOX.v}${ANSI.reset}`, w: cols })
    }
    if (detailLines.length > 5) {
      const more = `${ANSI.dim}… ${detailLines.length - 5} more lines${ANSI.reset}`
      rows.push({ text: `${ANSI.grey}${BOX.v}${ANSI.reset} ${padRight(more, inner)}${ANSI.grey}${BOX.v}${ANSI.reset}`, w: cols })
    }
    // Bottom border: └─ ✓ done ───────────┘
    rows.push({ text: `${ANSI.grey}${BOX.bl}${BOX.h} ${statusMark}${ANSI.reset}${ANSI.grey}${' '.repeat(Math.max(0, inner - 7))}${BOX.h}${BOX.br}${ANSI.reset}`, w: cols })
    return rows
  }

  private render(): void {
    if (this.exited) return
    const { rows, cols } = this.dims()
    const headerRows = 1
    const inputRows = 1
    const statusRows = 1
    const logRows = Math.max(1, rows - headerRows - inputRows - statusRows - 1)

    // Compose the full styled log.
    const styled: LogRow[] = []
    for (const entry of this.entries) {
      styled.push(...this.styleEntry(entry, cols))
    }
    if (this.pendingReasoning !== '' && this.showReasoning) {
      styled.push({ text: `${ANSI.grey}${ANSI.bold}✻ thinking${ANSI.reset}`, w: 10 })
      for (const line of wrapWords(mdPlain(this.pendingReasoning), cols - 4)) {
        const text = `${ANSI.grey}${ANSI.dim}${ANSI.italic}${styleMdLine(line)}${ANSI.reset}`
        styled.push({ text, w: width(text) })
      }
    }
    if (this.pendingText !== '') {
      styled.push(...styleMarkdown(this.pendingText, cols))
    }

    // Scrollback: `scroll` rows hidden from the bottom.
    const start = Math.max(0, styled.length - logRows - this.scroll)
    const visible = styled.slice(start, styled.length - this.scroll)

    // Header: brand left, model/session right.
    const right = `${ANSI.dim}${this.headerText}${ANSI.reset}`
    const left = `${ANSI.bold}DeepSeek Harness TUI${ANSI.reset}`
    const pad = Math.max(1, cols - width(left) - width(right))
    const header = `${left}${' '.repeat(pad)}${right}`

    let out = ANSI.hideCursor + ANSI.home
    out += header + '\n'
    for (let i = 0; i < logRows; i += 1) {
      const line = visible[i]
      if (line) out += `${ANSI.eraseLine}${line.text}\n`
      else out += `${ANSI.eraseLine}\n`
    }
    out += this.busy ? this.busyInputRow() : this.inputRow(cols)
    out += this.statusRow(cols)
    process.stdout.write(out + ANSI.showCursor)

    // Position the real cursor over the highlighted input character.
    if (!this.busy) {
      const inputRow = headerRows + logRows + 1
      const promptLen = 2 // "❯ "
      const inputCol = promptLen + Math.min(this.cursor, cols - promptLen - 2) + 1
      process.stdout.write(ANSI.cursorAt(inputRow, inputCol))
    }
  }

  private inputRow(cols: number): string {
    const prompt = `${ANSI.cyan}${ANSI.bold}❯ ${ANSI.reset}`
    // Single-row input that scrolls horizontally, like Claude Code.
    const maxLen = Math.max(1, cols - 2)
    const before = this.buffer.slice(0, this.cursor)
    const after = this.buffer.slice(this.cursor)
    const shown = before + after
    let offset = 0
    if (shown.length > maxLen) offset = shown.length - maxLen
    const cursorInShown = this.cursor - offset
    const cursorChar = shown[cursorInShown] ?? ' '
    const visBefore = shown.slice(0, cursorInShown)
    const visAfter = shown.slice(cursorInShown + 1)
    return `${ANSI.eraseLine}${prompt}${visBefore}${ANSI.inverse}${cursorChar}${ANSI.reset}${visAfter}\n`
  }

  private busyInputRow(): string {
    return `${ANSI.eraseLine}${ANSI.dim}${SPINNER[this.spinnerFrame]} thinking…${ANSI.reset}\n`
  }

  private statusRow(cols: number): string {
    const base = this.statusText
    const tokens = this.tokensIn + this.tokensOut > 0
      ? ` · ${this.tokensIn}→${this.tokensOut} tok${this.tokensReasoning > 0 ? ` (+${this.tokensReasoning} think)` : ''}`
      : ''
    const scrolled = this.scroll > 0 ? ` · ↑ ${this.scroll}` : ''
    const suggest = this.buffer.startsWith('/') ? this.suggestions() : ''
    const left = suggest || `${base}${tokens}${scrolled}`
    const busyMark = this.busy ? ` ${SPINNER[this.spinnerFrame]}` : ''
    const right = `${this.buffer.startsWith('/') ? '' : '/help'}${busyMark}`
    const pad = Math.max(1, cols - width(left) - width(right))
    return `${ANSI.eraseLine}${ANSI.dim}${left}${' '.repeat(pad)}${right}${ANSI.reset}\n`
  }

  private renderStatusLine(): void {
    if (this.exited) return
    const { rows, cols } = this.dims()
    process.stdout.write(ANSI.cursorAt(rows, 1) + this.statusRow(cols) + ANSI.showCursor)
  }

  private suggestions(): string {
    const prefix = this.buffer.slice(1).toLowerCase()
    const matches = this.commands.filter(c => c.name.startsWith(prefix)).map(c => `/${c.name}`)
    if (matches.length === 0) return `no command matches /${prefix}`
    return `${matches.join('  ')}   (Tab to complete)`
  }
}
