/**
 * One bounded, paginated HTTP interrogation of a provider's model-listing
 * endpoint.
 *
 * No retry policy lives here: a refresh is opportunistic, and a failure must
 * leave the stored list untouched. The caller schedules the next attempt.
 *
 * @module dsh-model-catalog-refresh/fetch
 */
import { type ListingProtocol } from './listing.js';
import type { DiscoveredModel } from './types.js';
/** Default per-request deadline. */
export declare const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
/** Default ceiling on one listing reply, enforced on bytes read rather than Content-Length alone. */
export declare const DEFAULT_MAX_RESPONSE_BYTES: number;
/** Upper bound on listing pages read for one provider. */
export declare const MAX_LISTING_PAGES = 20;
/** Inputs for one listing request. */
export interface FetchListingOptions {
    /** Configured provider endpoint. */
    readonly baseURL: string;
    /** Supported wire protocol. */
    readonly api: ListingProtocol;
    /** Credential value, already resolved; never logged. */
    readonly apiKey?: string;
    /** Provider-configured request headers. */
    readonly headers?: Readonly<Record<string, string>>;
    /** Cancellation from plugin disposal or a caller. */
    readonly signal?: AbortSignal;
    /** Per-request deadline. */
    readonly timeoutMs?: number;
    /** Reply byte ceiling. */
    readonly maxBytes?: number;
    /** Injectable fetch for tests. */
    readonly fetchImpl?: typeof fetch;
    /** User-Agent component; absent leaves the runtime default. */
    readonly userAgent?: string;
}
/** Resolved request facts used by tests and diagnostics. */
export interface ListingRequest {
    readonly url: URL;
    readonly headers: Headers;
}
/**
 * Accept a credential that can be sent as an HTTP header value, or refuse it
 * before fetch throws an opaque ByteString error. Surrounding whitespace is
 * trimmed, matching DSH's own credential normalization. The value never
 * appears in the diagnostic.
 * @param value - resolved credential.
 * @param ref - credential reference used in the message.
 * @returns the trimmed, usable value.
 */
export declare function assertHeaderSafeCredential(value: string, ref: string): string;
/**
 * Build the request URL and headers for one listing.
 * @param options - endpoint, protocol, and credential inputs.
 * @returns the URL and a detached header set.
 * @throws {CatalogRefreshError} for invalid configuration or an unusable credential.
 */
export declare function buildListingRequest(options: FetchListingOptions): ListingRequest;
/**
 * Describe the next page of one reply.
 *
 * Anthropic and Google publish a usable cursor, so their pages are followed.
 * OpenAI-compatible gateways have no single pagination contract; a reply that
 * says more rows exist is refused instead of merging a partial catalog and
 * deleting the rest, because an unadvertised page cannot be distinguished from
 * a retired model.
 * @param body - one decoded reply.
 * @param api - protocol that produced it.
 * @param current - URL that produced the reply.
 * @returns the next page URL, or undefined when the listing is complete.
 * @throws {CatalogRefreshError} when more pages are claimed but cannot be followed safely.
 */
export declare function nextListingPage(body: unknown, api: ListingProtocol, current: URL): URL | undefined;
/**
 * Fetch and parse one provider's model catalog, following the pagination
 * contracts this package can follow safely.
 * @param options - endpoint, protocol, credential, and bounds.
 * @returns chat-capable models in endpoint order.
 * @throws {CatalogRefreshError} for every expected failure, with a safe message.
 */
export declare function fetchModelListing(options: FetchListingOptions): Promise<DiscoveredModel[]>;
//# sourceMappingURL=fetch.d.ts.map