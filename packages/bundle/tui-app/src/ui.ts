/**
 * Terminal UI surface for @deepseek-ai/dsh-tui-app.
 *
 * A Claude Code / opencode-style full-screen layout rendered with raw ANSI:
 *
 *   ┌ DeepSeek Harness TUI · model · session ──────────────┐  header
 *   │ conversation scrollback (wrapped, colored)           │  log area
 *   │                                                      │
 *   │ ❯ input line with cursor, history, / completions     │  input row
 *   │ model · session · cwd · streaming · hints            │  status bar
 *   └──────────────────────────────────────────────────────┘
 *
 * Key handling (raw mode on a TTY): arrows move the cursor and walk prompt
 * history, Home/End, Backspace/Delete, Tab completes slash commands, Enter
 * submits, Ctrl+C clears (empty → exit), Ctrl+D exits. Non-TTY stdin (pipes)
 * falls back to plain line reads so the driver stays testable.
 *
 * @module @deepseek-ai/dsh-tui-app/ui
 */

import { createInterface, type Interface } from 'node:readline'
import { StringDecoder } from 'node:string_decoder'

/** One conversation log entry. */
export interface TuiEntry {
  kind: 'user' | 'assistant' | 'tool' | 'error' | 'system'
  text: string
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

const KIND_STYLE: Record<TuiEntry['kind'], string> = {
  user: `${ANSI.cyan}${ANSI.bold}`,
  assistant: `${ANSI.reset}`,
  tool: `${ANSI.dim}${ANSI.grey}`,
  error: `${ANSI.red}`,
  system: `${ANSI.dim}`,
}

const KIND_PREFIX: Record<TuiEntry['kind'], string> = {
  user: '❯ ',
  assistant: '',
  tool: '⏱ ',
  error: '✖ ',
  system: '',
}

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
 * slash-command completion, and the streaming "pending" assistant line.
 * The driver (index.ts) supplies callbacks for submitted prompts and
 * exit requests and drives turns by appending entries / stream chunks.
 */
export class Tui {
  private readonly commands: TuiCommand[]
  private readonly onPrompt: (line: string) => void
  private readonly onExit: () => void

  private entries: TuiEntry[] = []
  private pending = ''
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
    if (entry.kind === 'assistant' && this.pending !== '') {
      // Finalize any in-flight streamed line first.
      this.pushPending()
    }
    this.entries.push(entry)
    this.render()
  }

  /** Begin a streaming assistant response (clears any previous pending). */
  beginStreaming(): void {
    if (this.pending !== '') this.pushPending()
    this.pending = ''
  }

  /** Render one text delta into the streaming line. */
  streamChunk(text: string): void {
    this.pending += text
    this.queueRender()
  }

  /** End the streaming line; finalize it into the log. */
  endStreaming(): void {
    if (this.pending !== '') this.pushPending()
  }

  /** Set the status-bar text (model, session, streaming state, ...). */
  setStatus(text: string): void {
    this.statusText = text
    this.render()
  }

  /** Clear all conversation entries (e.g. /clear). */
  clearLog(): void {
    this.entries = []
    this.pending = ''
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

  private onChar(char: string): void {
    if (char === '\r' || char === '\n') {
      // Enter
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
    if (char >= ' ' && char !== '\x7f') {
      this.buffer = this.buffer.slice(0, this.cursor) + char + this.buffer.slice(this.cursor)
      this.cursor += char.length
      this.render()
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
    // The driver registers a handler; commands without one render usage.
    if (cmd.handler) {
      cmd.handler(args)
    } else {
      this.append({ kind: 'system', text: `${ANSI.bold}/${cmd.name}${ANSI.reset} ${cmd.usage} — ${cmd.help}` })
    }
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  private pushPending(): void {
    if (this.pending === '') return
    this.entries.push({ kind: 'assistant', text: this.pending })
    this.pending = ''
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

  private render(): void {
    if (this.exited) return
    const { rows, cols } = this.dims()
    const headerRows = 1
    const inputRows = 1
    const statusRows = 1
    const logRows = Math.max(1, rows - headerRows - inputRows - statusRows - 1)

    // Log area: wrapped lines from the tail.
    const wrapped: Array<{ kind: TuiEntry['kind']; line: string }> = []
    for (const entry of this.entries) {
      for (const line of wrap(entry.text, cols - 2)) {
        wrapped.push({ kind: entry.kind, line })
      }
    }
    if (this.pending !== '') {
      for (const line of wrap(this.pending, cols - 2)) {
        wrapped.push({ kind: 'assistant', line })
      }
    }
    const visible = wrapped.slice(-logRows)

    // Compose the frame.
    let out = ANSI.hideCursor + ANSI.home
    // Header
    out += `${ANSI.bold}DeepSeek Harness TUI${ANSI.reset}${ANSI.dim} — ${this.statusText}${ANSI.reset}\n`
    // Log
    for (let i = 0; i < logRows; i += 1) {
      const item = visible[i]
      if (item) {
        out += `${KIND_STYLE[item.kind]}${KIND_PREFIX[item.kind]}${item.line}${ANSI.reset}\n`
      } else {
        out += '\n'
      }
    }
    // Input row: prompt + buffer with the cursor character highlighted.
    const prompt = `${ANSI.cyan}${ANSI.bold}❯${ANSI.reset} `
    const promptLen = prompt.length - ANSI.cyan.length - ANSI.bold.length - ANSI.reset.length
    const before = this.buffer.slice(0, this.cursor)
    const after = this.buffer.slice(this.cursor)
    const cursorChar = after[0] ?? ' '
    out += `${ANSI.eraseLine}${prompt}${before}${ANSI.inverse}${cursorChar}${ANSI.reset}${after.slice(1)}\n`
    // Status bar: slash-command suggestions while typing a command.
    const suggest = this.buffer.startsWith('/') ? this.suggestions() : ''
    out += `${ANSI.eraseLine}${ANSI.dim}${suggest || this.statusText}${ANSI.reset}`
    process.stdout.write(out + ANSI.showCursor)
    // Position the real cursor over the highlighted character.
    const inputRow = headerRows + logRows + 1
    const inputCol = promptLen + this.cursor + 1
    process.stdout.write(ANSI.cursorAt(inputRow, inputCol))
  }

  private suggestions(): string {
    const prefix = this.buffer.slice(1).toLowerCase()
    const matches = this.commands.filter(c => c.name.startsWith(prefix)).map(c => `/${c.name}`)
    if (matches.length === 0) return `no command matches /${prefix}`
    return `${matches.join('  ')}   (Tab to complete)`
  }
}
