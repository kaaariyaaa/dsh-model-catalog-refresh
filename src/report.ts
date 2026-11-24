/**
 * Human-readable refresh reporting for the CLI and the Host log.
 *
 * @module dsh-model-catalog-refresh/report
 */

import type { RefreshReport } from './types.js'
import type { LoggerLike } from './service.js'

/** Strip control characters and bound one config-derived label. */
function safeText(value: string, maxLength = 300): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}…` : cleaned
}

/** Format a token-count delta for a provider line. */
function changeDetail(added: number, removed: number, total: number): string {
  const parts = [`${String(total)} model${total === 1 ? '' : 's'}`]
  if (added > 0) parts.push(`+${String(added)}`)
  if (removed > 0) parts.push(`-${String(removed)}`)
  return parts.join(', ')
}

/**
 * Render one refresh report as a short multi-line summary.
 * @param report - completed refresh.
 * @returns text without a trailing newline.
 */
export function formatReport(report: RefreshReport): string {
  const lines: string[] = [`model-catalog-refresh: ${report.reason} refresh`]
  if (report.error !== undefined) lines.push(`  error: ${safeText(report.error)}`)
  for (const provider of report.providers) {
    const label = safeText(provider.provider, 120)
    if (provider.status === 'failed') {
      lines.push(`  ${label}: FAILED — ${safeText(provider.error ?? 'unknown error')}`)
    } else if (provider.status === 'updated') {
      lines.push(`  ${label}: updated — ${changeDetail(provider.added.length, provider.removed.length, provider.total)}`)
    } else {
      lines.push(`  ${label}: unchanged — ${changeDetail(0, 0, provider.total)}`)
    }
  }
  if (report.providers.length === 0 && report.error === undefined) {
    lines.push('  no eligible API provider with an explicit model list')
  }
  const updated = report.providers.filter(provider => provider.status === 'updated').length
  const unchanged = report.providers.filter(provider => provider.status === 'unchanged').length
  lines.push(
    `model-catalog-refresh: ${String(updated)} updated, ${String(unchanged)} unchanged, `
    + `${String(report.failed)} failed in ${String(report.durationMs)}ms`
    + (report.written ? ' (saved)' : ''),
  )
  return lines.join('\n')
}

/**
 * Log one refresh report at levels appropriate for each line.
 * @param report - completed refresh.
 * @param logger - host logger.
 */
export function logReport(report: RefreshReport, logger: LoggerLike): void {
  if (report.error !== undefined) logger.error(`model-catalog-refresh: ${safeText(report.error)}`)
  for (const provider of report.providers) {
    const label = safeText(provider.provider, 120)
    if (provider.status === 'failed') {
      logger.warn(`model-catalog-refresh: ${label}: ${safeText(provider.error ?? 'unknown error')}`)
    } else if (provider.status === 'updated') {
      logger.info(
        `model-catalog-refresh: ${label}: ${changeDetail(provider.added.length, provider.removed.length, provider.total)}`,
      )
    }
  }
  logger.info(
    `model-catalog-refresh: ${report.reason} refresh finished: `
    + `${String(report.providers.filter(provider => provider.status === 'updated').length)} updated, `
    + `${String(report.providers.filter(provider => provider.status === 'unchanged').length)} unchanged, `
    + `${String(report.failed)} failed in ${String(report.durationMs)}ms`
    + (report.written ? ' (saved)' : ''),
  )
}
