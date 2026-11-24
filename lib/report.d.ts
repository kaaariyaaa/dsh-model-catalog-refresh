/**
 * Human-readable refresh reporting for the CLI and the Host log.
 *
 * @module dsh-model-catalog-refresh/report
 */
import type { RefreshReport } from './types.js';
import type { LoggerLike } from './service.js';
/**
 * Render one refresh report as a short multi-line summary.
 * @param report - completed refresh.
 * @returns text without a trailing newline.
 */
export declare function formatReport(report: RefreshReport): string;
/**
 * Log one refresh report at levels appropriate for each line.
 * @param report - completed refresh.
 * @param logger - host logger.
 */
export declare function logReport(report: RefreshReport, logger: LoggerLike): void;
//# sourceMappingURL=report.d.ts.map