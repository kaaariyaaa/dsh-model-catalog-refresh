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
import { CatalogRefreshError } from './errors.js';
/** Match the listing reader's id bounds so a stored list cannot smuggle an unsafe key. */
const MAX_MODEL_ID_LENGTH = 256;
const UNSAFE_MODEL_IDS = new Set(['__proto__', 'constructor', 'prototype']);
/** A plain data object. */
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/**
 * Validate and detach the stored list.
 * @param models - raw configured model list.
 * @returns a shallow copy of each valid entry.
 * @throws {CatalogRefreshError} when any entry is malformed or ids repeat.
 */
function storedModels(models) {
    const result = [];
    const seen = new Set();
    for (const [index, raw] of models.entries()) {
        if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.trim().length === 0) {
            throw new CatalogRefreshError('INVALID_EXISTING_MODELS', `the stored model list has an invalid entry at index ${String(index)}; fix it before refreshing`);
        }
        const id = raw.id;
        if (id.length > MAX_MODEL_ID_LENGTH
            || UNSAFE_MODEL_IDS.has(id)
            || /[\u0000-\u001f\u007f]/.test(id)) {
            throw new CatalogRefreshError('INVALID_EXISTING_MODELS', `the stored model list has an unsafe id at index ${String(index)}; fix it before refreshing`);
        }
        if (seen.has(id)) {
            throw new CatalogRefreshError('INVALID_EXISTING_MODELS', `the stored model list contains duplicate id "${id}"; fix it before refreshing`);
        }
        seen.add(id);
        result.push({ ...raw, id });
    }
    return result;
}
/** Build one new model entry from disclosed metadata only. */
function newEntry(model) {
    return {
        id: model.id,
        ...model.name === undefined || model.name === model.id ? {} : { name: model.name },
        ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
        ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
        ...model.input === undefined || model.input.length === 0 ? {} : { input: [...model.input] },
    };
}
/**
 * Merge one stored list with one freshly fetched list.
 * @param existing - the provider's current configured `models` array.
 * @param discovered - chat-capable models in endpoint order.
 * @returns the next list plus the added and removed id sets.
 * @throws {CatalogRefreshError} when the stored list is malformed or the listing is empty.
 */
export function mergeModelLists(existing, discovered) {
    if (discovered.length === 0) {
        throw new CatalogRefreshError('EMPTY_LISTING', 'the model listing contained no chat-capable models');
    }
    const stored = storedModels(existing);
    const discoveredIds = new Set(discovered.map(model => model.id));
    const storedIds = new Set(stored.map(model => model.id));
    const models = stored
        .filter(model => discoveredIds.has(model.id))
        .map(model => ({ ...model }));
    const added = [];
    for (const model of discovered) {
        if (storedIds.has(model.id))
            continue;
        models.push(newEntry(model));
        added.push(model.id);
    }
    const removed = stored.filter(model => !discoveredIds.has(model.id)).map(model => model.id);
    return { models, added, removed };
}
//# sourceMappingURL=merge.js.map