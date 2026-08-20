# Changelog

All notable changes to `dsh-tui`.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). This project is a DeepSeek Harness *plugin*; versions track the UI surface, while the runtime compatibility it expects is declared in its peer dependencies.

## [0.1.0] — unreleased

### Added
- Full-screen Claude Code / opencode-style terminal UI (alternate screen, header, scrollback, input bar, status bar).
- Live token streaming via `assistant/chunk` text deltas, with a `--no-streaming` / `/stream off` fallback.
- Reasoning ("thinking") display, streamed dim/italic, with `/reasoning on|off` and per-model effort selection.
- Box-drawn tool-call cards with lifecycle markers (`● running` → `✓ done` / `✖ error`) and arg/result previews.
- Lightweight markdown rendering for answers: fenced code blocks, inline code, bold, italic, headings, blockquotes, list bullets.
- Slash commands: `/help`, `/clear`, `/model`, `/resume`, `/compact`, `/permissions`, `/plan`, `/trajectory`, `/settings`, `/doctor`, `/version`, `/status`, `/reasoning`, `/stream`, `/exit`.
- Live model switching (mutates the shared `ModelSelectionRef`; persists via `agentDefaultModel.saveSelection`).
- Session listing and resume via `agents.resume()` with full history replay.
- Permission preset switching (read-only / workspace-write / danger-full-access) via `permissionPresets.set`.
- Plan-mode toggling via `planMode.set`.
- On-demand compaction via `compaction.compactNow`.
- Trajectory view with injected-context noise filtering.
- Environment diagnostics (`/doctor`): API key, workspace writability, model catalog, capability presence.
- Mouse-wheel scrollback (SGR reporting) plus `PgUp`/`PgDn`, with a `↑ N` scroll indicator.
- Emacs line editing (`Ctrl+A/E/U/K/W`), prompt history, slash-command tab completion, UTF-8 input.

### Fixed
- Status-bar redraw no longer scrolls the terminal (removed a trailing newline on the last row).
- `/stream` toggle now refreshes the status bar immediately.
- Streaming turns are no longer aborted by piped-stdin EOF (seed runs before readline opens; the loop settles between turns).
- Turn aggregation flushes the session before summarizing, matching the headless runner.
- User prompt wrapping only prefixes `❯` on the first line; code-block language tags are stripped.
