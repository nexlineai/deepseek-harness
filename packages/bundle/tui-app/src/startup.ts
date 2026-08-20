/**
 * The interactive app's command-line provider: it parses an optional seed task
 * positional plus `--streaming/--no-streaming`, prints `--help`, then publishes
 * {@link TUI_STARTUP_SERVICE}. The runner is an ordinary consumer whose lazy
 * config waits for that service.
 * @module @deepseek-ai/dsh-tui-app/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'tui-startup'

/** Services required before the flags can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this plugin and injected by the interactive runner. */
export const TUI_STARTUP_SERVICE = 'tuiStartup'

/** What the runner row reads from {@link TUI_STARTUP_SERVICE}. */
export interface TuiStartupValues {
  /** Optional seed task submitted immediately on boot; empty starts at the REPL prompt. */
  task: string
  /** Whether to render assistant/chunk deltas live (default true). */
  streaming: boolean
}

interface TuiOptions {
  streaming?: boolean
}

/**
 * This app's command: an optional seed task positional, stream toggle, and help.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function tuiCommand(): Command {
  return new Command()
    .name('dsh --profile tui')
    .description('Run an interactive DeepSeek Harness agent session in the terminal.')
    .helpOption('-h, --help', 'show this help')
    .option('--no-streaming', 'disable live token streaming; show each message once it completes')
    .argument('[task...]', 'optional seed task to submit on boot; multiple words are joined by spaces')
    .addHelpText('after', `
Examples:
  dsh --profile tui                          start an interactive session at the prompt
  dsh --profile tui "summarize this repo"    boot and immediately run one task
`)
}

/**
 * Parse and provide the interactive invocation as an ordinary Cordis service.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = tuiCommand()
  program.action(() => {
    const options = program.opts<TuiOptions>()
    ctx.provide(TUI_STARTUP_SERVICE, {
      task: program.args.join(' '),
      streaming: options.streaming !== false,
    } satisfies TuiStartupValues)
  })
  parseCmdline(ctx, program)
}
