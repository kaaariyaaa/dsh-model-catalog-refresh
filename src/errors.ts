/**
 * Stable failure vocabulary for one catalog refresh.
 *
 * Every message is safe to log: it may name a provider route, an endpoint
 * path, or a credential *reference*, but never a credential value, request
 * header, or response body.
 *
 * @module dsh-model-catalog-refresh/errors
 */

/** Failure categories a refresh report and the CLI can act on. */
export type CatalogRefreshErrorCode =
  | 'EMPTY_LISTING'
  | 'HTTP_ERROR'
  | 'INVALID_CONFIG'
  | 'INVALID_CREDENTIAL'
  | 'INVALID_EXISTING_MODELS'
  | 'INVALID_RESPONSE'
  | 'MISSING_CREDENTIAL'
  | 'NO_CONFIG_EDITOR'
  | 'REQUEST_FAILED'
  | 'TIMEOUT'
  | 'UNSUPPORTED_PROTOCOL'

/** One expected refresh failure, carrying a stable machine-readable code. */
export class CatalogRefreshError extends Error {
  /** Stable failure category. */
  readonly code: CatalogRefreshErrorCode

  /**
   * @param code - stable failure category.
   * @param message - safe, human-readable detail (no secrets).
   * @param options - optional cause; never rendered by this package.
   */
  constructor(code: CatalogRefreshErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CatalogRefreshError'
    this.code = code
  }
}

/**
 * Render a caught value for logs and the CLI without walking its cause chain,
 * which could contain a request URL with a secret query parameter.
 * @param error - caught value.
 * @returns a single-line, safe description.
 */
const SAFE_ERROR_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/

export function describeError(error: unknown): string {
  if (error instanceof CatalogRefreshError) return error.message
  // Foreign service errors (schema validation, YAML parsing, credential
  // providers) can embed the offending configuration value in their message.
  // Keep only a bounded error-class name so a credential or header cannot
  // reach a report or the Host log through this path.
  if (error instanceof Error && SAFE_ERROR_NAME.test(error.name)) {
    return `operation failed (${error.name})`
  }
  return 'operation failed'
}
