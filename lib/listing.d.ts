/**
 * Reading a provider model-listing reply into chat-capable model entries.
 *
 * The four listing protocols pi-ai-backed routes can speak are supported:
 * OpenAI Chat Completions and Responses (both `GET /models`), Anthropic
 * Messages (`GET /v1/models`), and Google Generative AI (`GET /models`).
 * Replies in the common gateway shapes are accepted, and entries that
 * explicitly describe a non-chat capability (embedding, decision, rerank, …)
 * are discarded so the ACP model selector never offers a model that cannot
 * serve a conversation.
 *
 * @module dsh-model-catalog-refresh/listing
 */
import type { DiscoveredModel } from './types.js';
/** Providers whose model listing this package can read. */
export declare const LISTING_PROTOCOLS: readonly ["anthropic-messages", "google-generative-ai", "openai-completions", "openai-responses"];
/** One supported listing protocol. */
export type ListingProtocol = (typeof LISTING_PROTOCOLS)[number];
/**
 * Whether a configured protocol has a listing reader here.
 * @param api - configured wire protocol.
 * @returns true when this package can interrogate that protocol.
 */
export declare function isListingProtocol(api: string): api is ListingProtocol;
/**
 * Whether a profile's protocol needs the `anthropic-version` header.
 * @param api - configured wire protocol.
 * @returns true for Anthropic Messages.
 */
export declare function isAnthropicProtocol(api: string): boolean;
/**
 * Anthropic's model-listing API version.
 * @returns the stable version string sent with Anthropic listing requests.
 */
export declare function anthropicVersion(): string;
/**
 * Join a configured base URL with the protocol's model-listing path.
 *
 * The base URL is treated as a prefix, not as a URL to resolve against, so a
 * gateway path such as `https://gateway.example/openai/v1` keeps every
 * segment. Anthropic publishes both `<root>` and `<root>/v1` spellings; one
 * trailing `/v1` is removed before its native `/v1/models` path is added.
 * Existing query parameters are preserved.
 *
 * @param baseURL - configured endpoint.
 * @param api - supported listing protocol.
 * @returns the absolute listing URL.
 * @throws {CatalogRefreshError} when the endpoint is not an absolute HTTP(S) URL.
 */
export declare function buildListingUrl(baseURL: string, api: ListingProtocol): URL;
/**
 * Render a URL for logs as its origin only. Provider endpoints sometimes carry
 * a credential in a query parameter, userinfo, or a path segment; none of
 * those are safe to print, and the provider route already identifies which
 * endpoint failed.
 * @param url - URL or URL string.
 * @returns the origin, or a fixed placeholder when unparseable.
 */
export declare function sanitizeUrl(url: string | URL): string;
/**
 * Flatten one reply into raw model-entry values.
 *
 * A map key is the request id, so it is stamped onto the value as `id`; this
 * lets paginated pages be concatenated into the `data`/`models` array shape
 * the parser already understands.
 * @param body - one decoded listing reply.
 * @returns raw entry objects, or an empty list for an empty page.
 * @throws {CatalogRefreshError} when the reply has no recognizable listing shape.
 */
export declare function listingRows(body: unknown): unknown[];
/**
 * Parse one provider listing reply.
 * @param body - decoded JSON reply.
 * @param api - protocol that produced the reply.
 * @returns chat-capable models in endpoint order, deduplicated by id.
 * @throws {CatalogRefreshError} when the reply has no recognizable listing or only non-chat entries.
 */
export declare function parseModelListing(body: unknown, api: ListingProtocol): DiscoveredModel[];
//# sourceMappingURL=listing.d.ts.map