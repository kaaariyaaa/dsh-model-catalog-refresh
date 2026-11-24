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
import type { Context } from '@deepseek-ai/cordis';
/** Stable plugin name for diagnostics. */
export declare const name = "model-catalog-refresh-acp";
/** Wait for the launcher command line only; the refresh service is an optional collaborator. */
export declare const inject: string[];
/** Build the ACP invocation program.
 * @param ctx - plugin context used by both actions.
 * @returns a fresh commander program.
 */
export declare function buildProgram(ctx: Context): Command;
/**
 * Mount the ACP startup provider.
 * @param ctx - plugin context carrying the launcher command line.
 */
export declare function apply(ctx: Context): void;
//# sourceMappingURL=acp.d.ts.map