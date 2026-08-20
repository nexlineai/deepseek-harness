/**
 * Terminal UI surface for @deepseek-ai/dsh-tui-app.
 *
 * A Claude Code / opencode-style full-screen layout rendered with raw ANSI:
 *
 *   ┌ DeepSeek Harness TUI · deepseek-official/deepseek-v4-flash · a1b2c3d4 ┐  header
 *   │ ──────────────────────────────────────────────────────────────────── │  turn separator
 *   │ ❯ count to 3                                                        │  user (bold, cyan prefix)
 *   │ · I need to produce a short sequence of integers...                  │  reasoning (dim italic)
 *   │ 1, 2, 3, 4, 5.                                                      │  assistant (streamed)
 *   │ ┌─ ⏱ bash ────────────────────────────────────────────────────────┐ │  tool block
 *   │ │ $ echo hello                                                     │ │
 *   │ └─ ✓ done ────────────────────────────────────────────────────────┘ │
 *   │ ✖ error message                                                     │  error (red)
 *   │ ❯ input line (single row, scrolls horizontally)                    │  input
 *   │ model · session · stream on · 12→45 tok · cwd          ⠋ /help    │  status bar
 *
 * Key handling (raw mode on a TTY): arrows move the cursor and walk prompt
 * history, Home/End, Backspace/Delete, Tab completes slash commands, Enter
 * submits, Alt+Enter inserts a newline, Ctrl+C clears (empty → exit), Ctrl+D
 * exits. Non-TTY stdin (pipes) falls back to plain line reads.
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

/** Box-drawing pieces for tool blocks. */
const BOX = {
  tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│',
} as const

/** Spinner frames while a turn is running. */
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** Wrap text to `cols` columns (ANSI-free width math). */
function wrap(text: string, cols: number): string[] {
  if (cols <= 0) return [text]
  const lines: string[] = []
  for (const raw of text.split('\n')) {
    if (raw === '') {
      lines.push('')
      continue
    }
    let rest = raw
    while (rest.length > cols) {
      lines.push(rest.slice(0, cols))
      rest = rest.slice(cols)
    }
    lines.push(rest)
  }
  return lines
}

/**
 * The full-screen surface. Owns raw-mode input, rendering, prompt history,
 * slash-command completion, streaming "pending" assistant/reasoning lines,
 * tool blocks, a busy spinner, and token counters. The driver (index.ts)
 * supplies callbacks for submitted prompts and exit requests and drives
 * turns by appending entries / stream chunks / tool results.
 */
export class Tui {
  private readonly commands: TuiCommand[]
  private readonly onPrompt: (line: string) => void
  private readonly onExit: () => void

  private entries: TuiEntry[] = []
  private pendingText = ''
  private pendingReasoning = ''
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

  // Busy state: spinner + live status redraw.
  private busy = false
  private spinnerFrame = 0
  private spinnerTimer: ReturnType<typeof setInterval> | undefined

  // Token accounting for the status bar.
  private tokensIn = 0
  private tokensOut = 0
  private tokensReasoning = 0

  /** Whether reasoning is currently rendered. */
  private showReasoning = true

  constructor(opts: {
    commands: TuiCommand[]
    onPrompt: (line: string) => void
    onExit: () => void
    status: string
  }) {
    this.commands = opts.commands
    this.onPrompt = opts.onPrompt
    this.onExit = opts.onExit
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

  /** Append a conversation entry and redraw. */
  append(entry: TuiEntry): void {
    if (this.exited) return
    if (entry.kind === 'assistant') this.pushPending()
    this.entries.push(entry)
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

  /** Set the status-bar base text (model, session, streaming state, ...). */
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
        // Alt+Enter arrives as ESC + CR: insert a newline instead of waiting.
        if (this.pendingEsc === '\x1b\r' || this.pendingEsc === '\x1b\n') {
          this.pendingEsc = ''
          this.insertChar('\n')
          continue
        }
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
    if (seq === '\x1b') return // lone ESC: ignore
    const code = seq.slice(2) // strip ESC [
    if (code === 'A') this.historyPrev()
    else if (code === 'B') this.historyNext()
    else if (code === 'C') this.cursor = Math.min(this.cursor + 1, this.buffer.length)
    else if (code === 'D') this.cursor = Math.max(this.cursor - 1, 0)
    else if (code === 'H' || code === '1~') this.cursor = 0
    else if (code === 'F' || code === '4~') this.cursor = this.buffer.length
    else if (code === '3~') this.deleteAt(this.cursor)
    this.render()
  }

  private insertChar(char: string): void {
    this.buffer = this.buffer.slice(0, this.cursor) + char + this.buffer.slice(this.cursor)
    this.cursor += char.length
    this.render()
  }

  private onChar(char: string): void {
    if (char === '\r' || char === '\n') {
      // Enter: submit (Alt+Enter inserts newline, handled in onData).
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
      // Tab: complete a slash command.
      this.completeCommand()
      return
    }
    if (char === '\x7f' || char === '\b') {
      // Backspace
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
  }

  private historyNext(): void {
    if (this.historyIndex < this.history.length) this.historyIndex += 1
    this.buffer = this.history[this.historyIndex] ?? ''
    this.cursor = this.buffer.length
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
    if (this.pendingText !== '') {
      this.entries.push({ kind: 'assistant', text: this.pendingText })
      this.pendingText = ''
    }
    if (this.pendingReasoning !== '' && this.showReasoning) {
      this.entries.push({ kind: 'reasoning', text: this.pendingReasoning })
      this.pendingReasoning = ''
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

  /** Style one entry into wrapped, ANSI-styled log rows. */
  private styleEntry(entry: TuiEntry, cols: number): string[] {
    switch (entry.kind) {
      case 'user':
        return wrap(`${ANSI.cyan}${ANSI.bold}❯ ${ANSI.reset}${entry.text}`, cols)
      case 'assistant':
        return wrap(entry.text, cols)
      case 'reasoning':
        return wrap(`${ANSI.grey}${ANSI.dim}${ANSI.italic}· ${entry.text}${ANSI.reset}`, cols)
      case 'error':
        return wrap(`${ANSI.red}✖ ${entry.text}${ANSI.reset}`, cols)
      case 'system':
        return wrap(`${ANSI.dim}${entry.text}${ANSI.reset}`, cols)
      case 'separator': {
        const line = BOX.h.repeat(Math.max(1, cols - 2))
        return [`${ANSI.dim}${line}${ANSI.reset}`]
      }
      case 'tool':
        return this.styleTool(entry, cols)
    }
  }

  /** Render a tool call as a box-drawn block with lifecycle status. */
  private styleTool(entry: TuiEntry, cols: number): string[] {
    const inner = Math.max(1, cols - 4)
    const title = `⏱ ${entry.name ?? 'tool'}`
    const statusMark = entry.status === 'done' ? `${ANSI.green}✓ done${ANSI.reset}`
      : entry.status === 'error' ? `${ANSI.red}✖ error${ANSI.reset}`
        : `${ANSI.yellow}● running${ANSI.reset}`
    const lines: string[] = []
    lines.push(`${ANSI.grey}${BOX.tl}${BOX.h} ${title} ${BOX.h.repeat(Math.max(0, inner - title.length - 2))}${BOX.tr}${ANSI.reset}`)
    const detailLines = wrap(entry.detail ?? '', inner)
    for (const detail of detailLines.slice(0, 5)) {
      lines.push(`${ANSI.grey}${BOX.v}${ANSI.reset} ${detail}`)
    }
    if (detailLines.length > 5) {
      lines.push(`${ANSI.grey}${BOX.v}${ANSI.reset} ${ANSI.dim}… ${detailLines.length - 5} more lines${ANSI.reset}`)
    }
    const statusLine = `${ANSI.grey}${BOX.bl}${BOX.h} ${statusMark}${ANSI.reset}`
    lines.push(statusLine)
    return lines
  }

  private render(): void {
    if (this.exited) return
    const { rows, cols } = this.dims()
    const headerRows = 1
    const inputRows = 1
    const statusRows = 1
    const logRows = Math.max(1, rows - headerRows - inputRows - statusRows - 1)

    // Compose the log area from entries + pending streaming lines.
    const styled: string[] = []
    for (const entry of this.entries) {
      styled.push(...this.styleEntry(entry, cols))
    }
    if (this.pendingText !== '') styled.push(...wrap(this.pendingText, cols))
    if (this.pendingReasoning !== '' && this.showReasoning) {
      styled.push(...wrap(`${ANSI.grey}${ANSI.dim}${ANSI.italic}· ${this.pendingReasoning}${ANSI.reset}`, cols))
    }
    const visible = styled.slice(-logRows)

    // Header: brand left, model/session right.
    const right = `${ANSI.dim}${this.statusText}${ANSI.reset}`
    const left = `${ANSI.bold}DeepSeek Harness TUI${ANSI.reset}`
    const pad = Math.max(1, cols - left.length - right.length)
    const header = `${left}${' '.repeat(pad)}${right}`

    let out = ANSI.hideCursor + ANSI.home
    out += header + '\n'
    for (let i = 0; i < logRows; i += 1) {
      const line = visible[i]
      if (line) out += `${ANSI.eraseLine}${line}\n`
      else out += `${ANSI.eraseLine}\n`
    }
    out += this.inputRow(cols)
    out += this.statusRow(cols)
    process.stdout.write(out + ANSI.showCursor)

    // Position the real cursor over the highlighted input character.
    const inputRow = headerRows + logRows + 1
    const promptLen = 2 // "❯ "
    const inputCol = promptLen + Math.min(this.cursor, cols - promptLen - 2) + 1
    process.stdout.write(ANSI.cursorAt(inputRow, inputCol))
  }

  private inputRow(cols: number): string {
    const prompt = `${ANSI.cyan}${ANSI.bold}❯ ${ANSI.reset}`
    // Single-row input that scrolls horizontally, like Claude Code.
    const maxLen = Math.max(1, cols - 2)
    const before = this.buffer.slice(0, this.cursor)
    const after = this.buffer.slice(this.cursor)
    // Visible window: show the tail of the buffer when it overflows.
    const shown = before + after
    let offset = 0
    if (shown.length > maxLen) offset = shown.length - maxLen
    const cursorInShown = this.cursor - offset
    const cursorChar = shown[cursorInShown] ?? ' '
    const visBefore = shown.slice(0, cursorInShown)
    const visAfter = shown.slice(cursorInShown + 1)
    return `${ANSI.eraseLine}${prompt}${visBefore}${ANSI.inverse}${cursorChar}${ANSI.reset}${visAfter}\n`
  }

  private statusRow(cols: number): string {
    const base = this.statusText
    const busyMark = this.busy ? ` ${SPINNER[this.spinnerFrame]}` : ''
    const tokens = this.tokensIn + this.tokensOut > 0
      ? ` · ${this.tokensIn}→${this.tokensOut} tok${this.tokensReasoning > 0 ? ` (+${this.tokensReasoning} think)` : ''}`
      : ''
    const suggest = this.buffer.startsWith('/') ? this.suggestions() : ''
    const left = suggest || `${base}${tokens}`
    const right = `${this.buffer.startsWith('/') ? '' : '/help'}${busyMark}`
    const total = left.length + right.length
    const pad = Math.max(1, cols - total)
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
