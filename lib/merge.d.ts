/**
 * Three-way-safe model list merging: add what the provider now serves, drop
 * what it no longer serves, and keep every existing entry byte-for-byte.
 *
 * "Keep the user's settings" is the reason existing entries are never
 * rewritten from discovered metadata. A user may have corrected a context
 * window, narrowed modalities, or supplied reasoning wire spellings; a
 * refresh must not undo that. Only ids absent from the stored list receive
 * metadata from the listing.
 *
 * @module dsh-model-catalog-refresh/merge
 */
import type { DiscoveredModel } from './types.js';
/** Result of merging one stored list with one listing. */
export interface MergeResult {
    /** Next stored model list: existing order first, new ids appended in endpoint order. */
    readonly models: Record<string, unknown>[];
    /** Ids present only in the listing, in endpoint order. */
    readonly added: string[];
    /** Ids present only in the stored list, in stored order. */
    readonly removed: string[];
}
/**
 * Merge one stored list with one freshly fetched list.
 * @param existing - the provider's current configured `models` array.
 * @param discovered - chat-capable models in endpoint order.
 * @returns the next list plus the added and removed id sets.
 * @throws {CatalogRefreshError} when the stored list is malformed or the listing is empty.
 */
export declare function mergeModelLists(existing: readonly unknown[], discovered: readonly DiscoveredModel[]): MergeResult;
//# sourceMappingURL=merge.d.ts.map