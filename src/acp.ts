/**
 * ACP startup entry with a `model-refresh` command.
 *
 * The shipped ACP app owns a zero-option commander program and claims stdio
 * from its default action. This entry replaces that row so the same default
 * action still serves every valid ACP invocation, while a `model-refresh`
 * subcommand refreshes all provider catalogs and exits before the ACP bridge
 * is told to claim stdio. Stdout therefore never carries a human line during
 * a normal ACP session.
 *
 * @module dsh-model-catalog-refresh/acp
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { ACP_APP_STARTUP_SERVICE } from '@deepseek-ai/dsh-acp-app'
import { exitOnStdinEnd, parseCmdline } from '@deepseek-ai/dsh-cmdline'
import type {} from './index.js'

import { describeError } from './errors.js'
import { formatReport } from './report.js'

/** Stable plugin name for diagnostics. */
export const name = 'model-catalog-refresh-acp'

/** Wait for the launcher command line and the refresh service before parsing. */
export const inject = ['cmdlineArgs', 'modelCatalogRefresh']

/**
 * Run one manual refresh, print its report, and request the process exit code.
 * @param ctx - plugin context carrying the refresh service and exit request.
 */
async function runManual(ctx: Context): Promise<void> {
  const report = await ctx.modelCatalogRefresh.refresh('manual')
  await new Promise<void>((resolve) => {
    process.stdout.write(`${formatReport(report)}\n`, () => { resolve() })
  })
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('the launcher did not provide ctx.appExit')
  exit(report.error !== undefined || report.failed > 0 ? 1 : 0)
}

/**
 * Run work after the root tree commits, or on the next turn when the launcher
 * supplied no readiness signal. The returned disposer cancels a pending start
 * when the plugin unloads before readiness.
 * @param ctx - plugin context.
 * @param callback - work to run after startup.
 */
function afterReady(ctx: Context, callback: () => void): void {
  const ready = ctx.get('appReady')
  if (ready === undefined) {
    setTimeout(callback, 0)
    return
  }
  const cancel = ready.onReady(callback)
  ctx.effect(() => () => { cancel() }, 'model-catalog-refresh.acp-ready')
}

/** Build the ACP invocation program.
 * @param ctx - plugin context used by both actions.
 * @returns a fresh commander program.
 */
export function buildProgram(ctx: Context): Command {
  const program = new Command()
    .name('dsh --profile acp')
    .description('Serve automation clients over Agent Client Protocol stdio.')
    .helpOption('-h, --help', 'show this help')
    .addHelpText('after', `
Examples:
  dsh --profile acp                 serve ACP until the client disconnects
  dsh --profile acp model-refresh   refresh catalogs without serving ACP
`)

  program.action(() => {
    exitOnStdinEnd(ctx, 'model-catalog-refresh.acp')
    ctx.provide(ACP_APP_STARTUP_SERVICE, { accepted: true })
    // appReady commits after the tree has mounted. Starting the first refresh
    // from that signal keeps startup work off the boot path and gives the ACP
    // bridge its stdio claim first.
    afterReady(ctx, () => { ctx.modelCatalogRefresh.start() })
  })

  program
    .command('model-refresh')
    .description('refresh every API provider model catalog now, then exit')
    .action(() => {
      // The ACP bundle marks its bridge row required, so the root tree only
      // commits appReady once that row has its startup service. Provide the
      // service here as well, but deliberately omit exitOnStdinEnd: this
      // invocation refreshes and exits, and must not bind its lifetime to
      // the client stdin stream.
      ctx.provide(ACP_APP_STARTUP_SERVICE, { accepted: true })
      const launch = (): void => {
        void runManual(ctx).catch((error: unknown) => {
          process.stderr.write(`model-catalog-refresh: ${describeError(error)}\n`)
          const exit = ctx.get('appExit')
          exit?.(1)
        })
      }
      // Commander parses during tree mount, when provider adapters and the
      // configuration editor may still be pending. appReady commits only after
      // the root tree is mounted, so refresh from that signal instead of
      // racing the composition.
      afterReady(ctx, launch)
    })

  return program
}

/**
 * Mount the ACP startup provider.
 * @param ctx - plugin context carrying the launcher command line.
 */
export function apply(ctx: Context): void {
  parseCmdline(ctx, buildProgram(ctx))
}
