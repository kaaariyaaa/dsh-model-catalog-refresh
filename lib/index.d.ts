/**
 * DSH ACP model-catalog refresh plugin.
 *
 * On an ACP profile this mounts one refresh service and one four-hour
 * scheduler. The service discovers eligible API providers from the public
 * configurable-provider directory, interrogates each listing endpoint, merges
 * the result with the stored list, and persists only the `models` array
 * through the profile's configuration editor. Server configuration,
 * credentials, headers, and model-level customization stay untouched.
 *
 * The companion entry `dsh-model-catalog-refresh/acp` replaces the ACP app's
 * startup row so `dsh --profile acp model-refresh` can run one refresh and
 * exit without binding the process lifetime to ACP stdin.
 *
 * @module dsh-model-catalog-refresh
 */
import type { Context } from '@deepseek-ai/cordis';
import type { RefreshReason, RefreshReport } from './types.js';
export { ModelCatalogRefresh } from './service.js';
export type { ConfigSnapshot, LoggerLike, ModelListUpdate, ProviderDirectoryEntry, RefreshDeps, } from './service.js';
export { mergeModelLists } from './merge.js';
export type { MergeResult } from './merge.js';
export { buildListingRequest, fetchModelListing, type FetchListingOptions, } from './fetch.js';
export { LISTING_PROTOCOLS, buildListingUrl, parseModelListing, sanitizeUrl, type ListingProtocol, } from './listing.js';
export { formatReport, logReport } from './report.js';
export type { CatalogModality, DiscoveredModel, ProviderRefreshReport, ProviderRefreshStatus, RefreshReason, RefreshReport, } from './types.js';
/** Stable plugin name for diagnostics. */
export declare const name = "model-catalog-refresh";
/** The LLM registry is required; the configuration editor and credentials are probed per run. */
export declare const inject: string[];
/** Fixed automatic refresh interval: four hours. */
export declare const REFRESH_INTERVAL_MS: number;
/** Public service the ACP startup entry calls. */
export interface ModelCatalogRefreshApi {
    /**
     * Refresh every eligible provider, joining an in-flight run.
     * @param reason - why the caller is refreshing.
     * @returns the completed report.
     */
    refresh(reason: RefreshReason): Promise<RefreshReport>;
    /** Start one post-startup refresh and the four-hour interval. Idempotent. */
    start(): void;
    /** Whether a refresh is currently running. */
    isRefreshing(): boolean;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** Model catalog refresh service provided by this plugin. */
        modelCatalogRefresh: ModelCatalogRefreshApi;
    }
}
/**
 * Mount the refresh service.
 * @param ctx - plugin context with the LLM registry and a writable profile.
 */
export declare function apply(ctx: Context): void;
//# sourceMappingURL=index.d.ts.map