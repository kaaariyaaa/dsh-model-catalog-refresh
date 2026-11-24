/**
 * ACP startup entry with a `model-refresh` command.
 *
 * The shipped ACP app owns a zero-option commander program and claims stdio
 * from its default action. This entry replaces that row so the same default
 * action still serves every valid ACP invocation, while a `model-refresh`
 * subcommand refreshes all provider catalogs and exits without binding its
 * lifetime to ACP stdin. Stdout therefore never carries a human line during a
 * normal ACP session.
 *
 * @module dsh-model-catalog-refresh/acp
 */
import { Command } from 'commander';
import { exitOnStdinEnd, parseCmdline } from '@deepseek-ai/dsh-cmdline';
import { describeError } from './errors.js';
import { formatReport } from './report.js';
/** Service name the ACP bridge row waits for; part of the ACP app's public contract. */
const ACP_APP_STARTUP_SERVICE = 'acpAppStartup';
/** Stable plugin name for diagnostics. */
export const name = 'model-catalog-refresh-acp';
/** Wait for the launcher command line only; the refresh service is an optional collaborator. */
export const inject = ['cmdlineArgs'];
/**
 * Run one manual refresh, print its report, and request the process exit code.
 * @param ctx - plugin context carrying the refresh service and exit request.
 */
async function runManual(ctx, refresh) {
    const report = await refresh.refresh('manual');
    await new Promise((resolve) => {
        process.stdout.write(`${formatReport(report)}\n`, () => { resolve(); });
    });
    const exit = ctx.get('appExit');
    if (exit === undefined)
        throw new Error('the launcher did not provide ctx.appExit');
    exit(report.error !== undefined || report.failed > 0 ? 1 : 0);
}
/**
 * Run work after the root tree commits, or on the next turn when the launcher
 * supplied no readiness signal. The returned disposer cancels a pending start
 * when the plugin unloads before readiness.
 * @param ctx - plugin context.
 * @param callback - work to run after startup.
 */
function afterReady(ctx, callback) {
    const ready = ctx.get('appReady');
    if (ready === undefined) {
        const timer = setTimeout(callback, 0);
        timer.unref?.();
        ctx.effect(() => () => { clearTimeout(timer); }, 'model-catalog-refresh.acp-ready');
        return;
    }
    const cancel = ready.onReady(callback);
    ctx.effect(() => () => { cancel(); }, 'model-catalog-refresh.acp-ready');
}
/** Build the ACP invocation program.
 * @param ctx - plugin context used by both actions.
 * @returns a fresh commander program.
 */
export function buildProgram(ctx) {
    const program = new Command()
        .name('dsh --profile acp')
        .description('Serve automation clients over Agent Client Protocol stdio.')
        .helpOption('-h, --help', 'show this help')
        .addHelpText('after', `
Examples:
  dsh --profile acp                 serve ACP until the client disconnects
  dsh --profile acp model-refresh   refresh catalogs without serving ACP
`);
    program.action(() => {
        exitOnStdinEnd(ctx, 'model-catalog-refresh.acp');
        ctx.provide(ACP_APP_STARTUP_SERVICE, { accepted: true });
        // appReady commits after the tree has mounted. Starting the first refresh
        // from that signal keeps startup work off the boot path and gives the ACP
        // bridge its stdio claim first. A missing refresh service must not prevent
        // ACP from serving; it only loses automatic catalog maintenance.
        afterReady(ctx, () => {
            const refresh = ctx.get('modelCatalogRefresh');
            if (refresh === undefined) {
                ctx.logger.warn('model-catalog-refresh: the refresh service is not mounted; serving ACP without automatic refresh');
                return;
            }
            refresh.start();
        });
    });
    program
        .command('model-refresh')
        .description('refresh every API provider model catalog now, then exit')
        .action(() => {
        // The bundle patch disables the ACP bridge row for this invocation, so
        // no acpAppStartup consumer exists and nothing can bind stdin. appReady
        // still commits once the rest of the tree mounts.
        const launch = () => {
            const refresh = ctx.get('modelCatalogRefresh');
            if (refresh === undefined) {
                process.stderr.write('model-catalog-refresh: the refresh service is not mounted\n', () => {
                    ctx.get('appExit')?.(1);
                });
                return;
            }
            void runManual(ctx, refresh).catch((error) => {
                const exit = ctx.get('appExit');
                process.stderr.write(`model-catalog-refresh: ${describeError(error)}\n`, () => { exit?.(1); });
            });
        };
        // Commander parses during tree mount, when provider adapters and the
        // configuration editor may still be pending. appReady commits only after
        // the root tree is mounted, so refresh from that signal instead of
        // racing the composition.
        afterReady(ctx, launch);
    });
    return program;
}
/**
 * Mount the ACP startup provider.
 * @param ctx - plugin context carrying the launcher command line.
 */
export function apply(ctx) {
    parseCmdline(ctx, buildProgram(ctx));
}
//# sourceMappingURL=acp.js.map