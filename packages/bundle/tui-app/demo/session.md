# dsh-tui demo

A short, representative session. Everything below is real output from
`dsh --profile tui` (ANSI stripped, re-renders collapsed); paths are
generalized to `~/project`.

## Boot

```
DeepSeek Harness TUI        deepseek-official/deepseek-v4-flash · session 9ce49deb
```

## A tool-using turn (streamed)

```
❯ read the LICENSE file and tell me its license

✻ thinking
  · The user wants me to read the LICENSE file and tell me its license.
  · Simple task — let me read it.

┌─ ⏱ read ─────────────────────────────────────────────────────────────────────┐
│ {"file_path": "~/project/LICENSE"}                                            │
└─ ✓ done ──────────────────────────────────────────────────────────────────────┘

The project is licensed under the **MIT License** — free to use, copy,
modify, merge, publish, distribute…

────────────────────────────────────────────────────────── 15:35:34 · 5s · 12→45 tok
```

## Trajectory (`/trajectory`)

```
 4 ▶ turn 1
 7 ❯ read the LICENSE file and tell me its license
66 ● (reasoning)
67 ⏱ read {"file_path": "…/LICENSE"}
68 ✓ ok
139 ● The project is licensed under the MIT License.
141 ⏹ completed
```

## Doctor (`/doctor`)

```
dsh-tui doctor
✓ DeepSeek API key — DEEPSEEK_API_KEY set
✓ workspace — ~/project readable + writable
✓ models — 2 model(s) across 1 provider(s)
✓ session persistence — session list/resume available
✓ compaction — compaction available
✓ plan mode — plan mode available
```

## Model picker (`/model`)

```
deepseek-v4-flash  (DeepSeek) [reasoning: off/low/high/max]
deepseek-v4-pro   (DeepSeek) [reasoning: off/low/high/max] ● active
```

## Settings (`/settings`)

```
current session
  model      deepseek-official/deepseek-v4-pro (reasoning high)
  stream     on · reasoning display on
  permission workspace-write
  plan mode  off
  session    session-9ce49deb · 1 turns · 45 events
```
