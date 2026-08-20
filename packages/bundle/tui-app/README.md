# dsh-tui

> A full-screen interactive terminal UI for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) agent runtime — the web UI, reimagined for the terminal.

[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-555)](./README.md)

**`dsh-tui`** runs the official DeepSeek Harness *agent* (tools, file editing, shell, subagents, sessions, permissions, plan mode) behind a Claude Code / opencode-style interface — live token streaming, reasoning blocks, boxed tool cards, prompt history, and a full slash-command suite. No browser, no Electron, just your terminal.

It is **not** a model wrapper or a plain chat REPL — it drives the real agent runtime.

---

## Features

- **Live streaming** — answers render token-by-token as the model generates.
- **Reasoning display** — `thinking` blocks stream dim/italic, with per-turn effort control (`/model <id> high`).
- **Tool cards** — box-drawn `⏱ bash` blocks with lifecycle markers (`● running → ✓ done / ✖ error`) and arg/result previews.
- **Full agent toolkit** — the agent can read/edit files, run commands, delegate subagents, and execute plans.
- **Session management** — list and resume any persisted session (`/resume`).
- **Permission modes** — `read-only` / `workspace-write` / `danger-full-access`, switchable live (`/permissions`).
- **Plan mode** — toggle plan-first behavior (`/plan`).
- **Compaction** — shrink the conversation on demand (`/compact`).
- **Trajectory** — a filtered event timeline of the whole session (`/trajectory`).
- **Diagnostics** — environment + model-catalog health check (`/doctor`).
- **Scrollback** — mouse wheel / `PgUp` / `PgDn`, with `↑ N` indicator.
- **Markdown rendering** — fenced code blocks, inline code, bold, headings, lists.
- **Cross-platform** — macOS and Linux terminals (iTerm2, Terminal.app, kitty, alacritty, xterm, …).

---

## Install

`dsh-tui` is a [DeepSeek Harness plugin](https://github.com/topics/dsh-plugin). You need the official `dsh` installed first:

```bash
# 1. Install the official DeepSeek Harness (once)
npx @deepseek-ai/dsh web --help   # or: npm i -g @deepseek-ai/dsh

# 2. Create a `tui` profile and add this plugin
dsh plugin --profile tui add dsh-tui

# 3. Run it
dsh --profile tui
```

The profile initializes on first use; `dsh-tui` composes over the same `@deepseek-ai/dsh-base` core as the web UI.

### Model key

```bash
export DEEPSEEK_API_KEY=sk-...
```

The TUI uses the same credential sources as the harness (`DEEPSEEK_API_KEY` / `settings.yaml`).

---

## Commands

| Command | Description |
|---|---|
| `/help` | list commands |
| `/model` | list models + reasoning efforts; `● active` marks current |
| `/model <id> [effort]` | switch live, e.g. `/model deepseek-v4-pro high` |
| `/resume` | list persisted sessions (id, title, date) |
| `/resume <n>` | continue that session with full history |
| `/permissions` | list permission presets |
| `/permissions <name>` | switch (`read-only` / `workspace-write` / `danger-full-access`) |
| `/plan` | toggle plan mode |
| `/compact` | compact the conversation now |
| `/trajectory` | show the session event timeline |
| `/settings` | one-screen summary of model/permission/plan/stream state |
| `/doctor` | environment + model catalog health check |
| `/version` | dsh-tui + runtime versions |
| `/status` | session, cwd, event and turn counts |
| `/reasoning on\|off` | show/hide the thinking display |
| `/stream on\|off` | toggle live token streaming |
| `/clear` | clear the conversation area |
| `/exit` (or `q`, `quit`, `:q`, `Ctrl+D`) | leave |

---

## Keybindings

| Key | Action |
|---|---|
| `Enter` | submit |
| `↑` / `↓` | prompt history |
| `←` / `→` | move cursor |
| `Home` / `End` (`Ctrl+A` / `Ctrl+E`) | line start / end |
| `Backspace` / `Delete` | delete |
| `Ctrl+U` / `Ctrl+K` | kill to start / end |
| `Ctrl+W` | delete previous word |
| `Esc` | clear the input line |
| `Tab` | complete a slash command |
| `Ctrl+C` | clear (empty → exit) |
| `Ctrl+D` | exit |
| `PgUp` / `PgDn` / mouse wheel | scroll the conversation |

---

## Layout

```
┌ DeepSeek Harness TUI            deepseek-official/deepseek-v4-pro · session a1b2c3d4 ┐
│ ─────────────────────────────────────────────────────────────── 15:35:34 · 2s · 12→45 tok │
│ ❯ list the files                                                                     │
│ ✻ thinking                                                                            │
│   · a simple listing; I'll use bash ls                                                 │
│ This is the repository root — a plugin-based agent harness with pnpm workspaces...    │
│ ┌─ ⏱ bash ──────────────────────────────────────────────────────────────────────────┐ │
│ │ $ ls -la                                                                           │ │
│ └─ ✓ done ───────────────────────────────────────────────────────────────────────────┘ │
│ ❯ your input                                                                          │
│ ~/project · stream on · 1 turns · 500→120 tok                              ↑ /help  │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

---

## How it differs from the web UI

Same agent, same permissions, same sessions — but everything happens in your terminal. `dsh-tui` is aimed at people who live in a terminal, want a keyboard-first flow, or run the harness over SSH / inside a multiplexer like [herdr](https://herdr.dev) or tmux.

## Why a separate CLI?

The official `dsh` ships a `web` UI and a one-shot `headless` mode — no interactive terminal agent. `dsh-tui` fills that gap as an installable plugin, without forking the runtime.

---

## License

MIT — see [LICENSE](./LICENSE). Not affiliated with DeepSeek AI; the runtime it drives is [MIT-licensed](https://github.com/deepseek-ai/deepseek-harness) upstream.
