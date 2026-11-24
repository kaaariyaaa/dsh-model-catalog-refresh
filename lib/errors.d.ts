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
export type CatalogRefreshErrorCode = 'EMPTY_LISTING' | 'HTTP_ERROR' | 'INVALID_CONFIG' | 'INVALID_CREDENTIAL' | 'INVALID_EXISTING_MODELS' | 'INVALID_RESPONSE' | 'MISSING_CREDENTIAL' | 'NO_CONFIG_EDITOR' | 'REQUEST_FAILED' | 'TIMEOUT' | 'UNSUPPORTED_PROTOCOL';
/** One expected refresh failure, carrying a stable machine-readable code. */
export declare class CatalogRefreshError extends Error {
    /** Stable failure category. */
    readonly code: CatalogRefreshErrorCode;
    /**
     * @param code - stable failure category.
     * @param message - safe, human-readable detail (no secrets).
     * @param options - optional cause; never rendered by this package.
     */
    constructor(code: CatalogRefreshErrorCode, message: string, options?: ErrorOptions);
}
export declare function describeError(error: unknown): string;
/**
 * Describe a configuration-write failure without echoing foreign error text.
 *
 * The configuration editor's home-patch/overlay refusal is a fixed, safe
 * message that tells the user exactly what to remove, so it is surfaced as
 * guidance. Every other foreign error is reduced to its class name by
 * {@link describeError}.
 * @param error - caught value from a configuration write.
 * @returns a safe, actionable message.
 */
export declare function describeConfigWriteError(error: unknown): string;
//# sourceMappingURL=errors.d.ts.map