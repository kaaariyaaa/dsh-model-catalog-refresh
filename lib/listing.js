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
import { CatalogRefreshError } from './errors.js';
/** Providers whose model listing this package can read. */
export const LISTING_PROTOCOLS = [
    'anthropic-messages',
    'google-generative-ai',
    'openai-completions',
    'openai-responses',
];
/** Largest model id accepted from a listing; ids are route keys, not prose. */
const MAX_MODEL_ID_LENGTH = 256;
/** Largest display name accepted from a listing. */
const MAX_MODEL_NAME_LENGTH = 200;
/** Model ids that could be mistaken for object-prototype keys downstream. */
const UNSAFE_MODEL_IDS = new Set(['__proto__', 'constructor', 'prototype']);
/** Whether a listing value contains terminal/log control characters. */
function hasControlCharacters(value) {
    return /[\u0000-\u001f\u007f]/.test(value);
}
/** Largest listing page requested from Anthropic. */
const ANTHROPIC_MODEL_LIMIT = 1000;
/** Largest listing page requested from Google. */
const GEMINI_MODEL_LIMIT = 1000;
/** Anthropic's required model-listing API version. */
const ANTHROPIC_VERSION = '2023-06-01';
/** Id families that are unambiguously not chat endpoints when a listing omits a type. */
const NON_CHAT_ID = /(^|[-_/.])(embedding|embeddings|embed|rerank|reranker|moderation|whisper|tts|speech|transcription|transcribe|realtime|sora|dall-e|gpt-image|stable-diffusion|sdxl)([-_/.]|$)/i;
/** Entry types that cannot serve a chat completion. */
const NON_CHAT_TYPES = new Set([
    'audio',
    'decision',
    'embedding',
    'embeddings',
    'image',
    'images',
    'moderation',
    'moderations',
    'rerank',
    'reranker',
    'speech',
    'transcription',
    'tts',
    'video',
    'whisper',
]);
/**
 * Whether a configured protocol has a listing reader here.
 * @param api - configured wire protocol.
 * @returns true when this package can interrogate that protocol.
 */
export function isListingProtocol(api) {
    return LISTING_PROTOCOLS.includes(api);
}
/**
 * Whether a profile's protocol needs the `anthropic-version` header.
 * @param api - configured wire protocol.
 * @returns true for Anthropic Messages.
 */
export function isAnthropicProtocol(api) {
    return api === 'anthropic-messages';
}
/**
 * Anthropic's model-listing API version.
 * @returns the stable version string sent with Anthropic listing requests.
 */
export function anthropicVersion() {
    return ANTHROPIC_VERSION;
}
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
export function buildListingUrl(baseURL, api) {
    let url;
    try {
        url = new URL(baseURL);
    }
    catch (error) {
        throw new CatalogRefreshError('INVALID_CONFIG', 'the provider baseURL is not an absolute URL', { cause: error });
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new CatalogRefreshError('INVALID_CONFIG', 'the provider baseURL must use http or https');
    }
    let path = url.pathname.replace(/\/+$/, '');
    if (api === 'anthropic-messages') {
        if (path.endsWith('/v1'))
            path = path.slice(0, -3);
        url.pathname = `${path}/v1/models`;
        url.searchParams.set('limit', String(ANTHROPIC_MODEL_LIMIT));
    }
    else if (api === 'google-generative-ai') {
        url.pathname = `${path}/models`;
        url.searchParams.set('pageSize', String(GEMINI_MODEL_LIMIT));
    }
    else {
        url.pathname = `${path}/models`;
    }
    url.hash = '';
    return url;
}
/**
 * Render a URL for logs as its origin only. Provider endpoints sometimes carry
 * a credential in a query parameter, userinfo, or a path segment; none of
 * those are safe to print, and the provider route already identifies which
 * endpoint failed.
 * @param url - URL or URL string.
 * @returns the origin, or a fixed placeholder when unparseable.
 */
export function sanitizeUrl(url) {
    try {
        const parsed = url instanceof URL ? url : new URL(url);
        return parsed.origin;
    }
    catch {
        return '<invalid URL>';
    }
}
/** A plain data object. */
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** First positive integer among candidate fields. */
function positiveInteger(...candidates) {
    for (const candidate of candidates) {
        if (typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0)
            return candidate;
    }
    return undefined;
}
/** First non-empty string among candidate fields. */
function nonEmptyString(...candidates) {
    for (const candidate of candidates) {
        if (typeof candidate === 'string') {
            const value = candidate.trim();
            if (value.length > 0)
                return value;
        }
    }
    return undefined;
}
/** Read one nested plain-object field. */
function nested(value, key) {
    return isRecord(value) ? value[key] : undefined;
}
/** Normalize strings from an explicit modality array. */
function modalitiesOf(value) {
    if (!Array.isArray(value))
        return undefined;
    const found = [];
    for (const raw of value) {
        if (typeof raw !== 'string')
            continue;
        const item = raw.trim().toLowerCase();
        if (item === 'text' || item.startsWith('text/')) {
            if (!found.includes('text'))
                found.push('text');
        }
        else if (item === 'image' || item.startsWith('image/')) {
            if (!found.includes('image'))
                found.push('image');
        }
    }
    return found.length > 0 ? found : undefined;
}
/** Explicit input modalities from the shapes gateways commonly publish. */
function inputModalities(entry) {
    return modalitiesOf(entry.input_modalities)
        ?? modalitiesOf(entry.inputModalities)
        ?? modalitiesOf(nested(entry.modalities, 'input'))
        ?? modalitiesOf(nested(entry.architecture, 'input_modalities'));
}
/** Output modalities when the endpoint states them. */
function outputModalities(entry) {
    const value = entry.output_modalities ?? entry.outputModalities ?? nested(entry.modalities, 'output');
    if (!Array.isArray(value))
        return undefined;
    const found = [];
    for (const raw of value) {
        if (typeof raw === 'string')
            found.push(raw.trim().toLowerCase());
    }
    return found.length > 0 ? found : undefined;
}
/** Whether an output list contains a text modality. */
function hasTextOutput(output) {
    return output.some(item => item === 'text' || item.startsWith('text/'));
}
/** Whether an entry explicitly identifies a model that cannot serve a conversation. */
function isNonChatEntry(entry) {
    const type = nonEmptyString(entry.type)?.toLowerCase();
    if (type !== undefined && NON_CHAT_TYPES.has(type))
        return true;
    if (nonEmptyString(entry.object)?.toLowerCase() === 'embedding')
        return true;
    if (nested(entry.capabilities, 'embedding') === true)
        return true;
    const output = outputModalities(entry);
    if (output !== undefined && !hasTextOutput(output))
        return true;
    // Official OpenAI listings carry no type for embedding/image models, and
    // some gateways use `type: model` for every entry, so a conservative
    // id-family check keeps them out of ACP's chat selector.
    if (type === undefined || type === 'model') {
        const id = nonEmptyString(entry.id, entry.name);
        if (id !== undefined && NON_CHAT_ID.test(id))
            return true;
    }
    return false;
}
/** Extract the entry list from the reply shapes gateways use. */
function rawEntries(body) {
    const list = (values) => values.flatMap(value => {
        if (typeof value === 'string' && value.trim().length > 0)
            return [{ value: { id: value } }];
        return isRecord(value) ? [{ value }] : [];
    });
    if (Array.isArray(body))
        return list(body);
    if (!isRecord(body)) {
        throw new CatalogRefreshError('INVALID_RESPONSE', 'the model listing is not a JSON object or array');
    }
    const data = body.data;
    if (Array.isArray(data))
        return list(data);
    if (isRecord(data) && Array.isArray(data.models))
        return list(data.models);
    const models = body.models;
    if (Array.isArray(models))
        return list(models);
    if (isRecord(models)) {
        return Object.entries(models).flatMap(([key, value]) => isRecord(value) ? [{ key, value }] : []);
    }
    throw new CatalogRefreshError('INVALID_RESPONSE', 'the model listing has neither a "data" array nor a "models" array or object');
}
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
export function listingRows(body) {
    return rawEntries(body).map(({ key, value }) => {
        if (key === undefined || key.length === 0)
            return value;
        return { ...value, id: key };
    });
}
/** Read one raw entry, or undefined when it is not a usable chat model. */
function normalizeEntry(entry, api) {
    const raw = entry.value;
    if (isNonChatEntry(raw))
        return undefined;
    if (api === 'google-generative-ai') {
        const methods = raw.supportedGenerationMethods;
        if (Array.isArray(methods) && !methods.includes('generateContent'))
            return undefined;
    }
    const gemini = api === 'google-generative-ai';
    const id = nonEmptyString(entry.key, gemini ? raw.name : raw.id)
        ?.replace(/^models\//, '');
    if (id === undefined
        || id.length === 0
        || id.length > MAX_MODEL_ID_LENGTH
        || UNSAFE_MODEL_IDS.has(id)
        || hasControlCharacters(id))
        return undefined;
    // Gemini's `name` is the resource id, not a label; its human label is
    // `displayName`. Other protocols publish a label in `name`.
    const geminiName = typeof raw.name === 'string' ? raw.name.replace(/^models\//, '') : undefined;
    const candidateName = gemini
        ? nonEmptyString(raw.displayName, raw.display_name, geminiName)
        : nonEmptyString(raw.name, raw.display_name, raw.displayName);
    const name = candidateName === undefined
        || candidateName.length > MAX_MODEL_NAME_LENGTH
        || hasControlCharacters(candidateName)
        ? undefined
        : candidateName;
    const contextWindow = positiveInteger(raw.contextWindow, raw.context_window, raw.context_length, raw.max_input_tokens, nested(raw.limit, 'context'), raw.inputTokenLimit);
    const maxTokens = positiveInteger(raw.maxOutputTokens, raw.max_output_tokens, raw.maxTokens, raw.max_tokens, raw.max_completion_tokens, nested(raw.limit, 'output'), nested(raw.top_provider, 'max_completion_tokens'), raw.outputTokenLimit);
    const input = inputModalities(raw);
    return {
        id,
        ...name === undefined ? {} : { name },
        ...contextWindow === undefined ? {} : { contextWindow },
        ...maxTokens === undefined ? {} : { maxTokens },
        ...input === undefined ? {} : { input },
    };
}
/**
 * Parse one provider listing reply.
 * @param body - decoded JSON reply.
 * @param api - protocol that produced the reply.
 * @returns chat-capable models in endpoint order, deduplicated by id.
 * @throws {CatalogRefreshError} when the reply has no recognizable listing or only non-chat entries.
 */
export function parseModelListing(body, api) {
    const models = [];
    const seen = new Set();
    for (const entry of rawEntries(body)) {
        const model = normalizeEntry(entry, api);
        if (model === undefined || seen.has(model.id))
            continue;
        seen.add(model.id);
        models.push(model);
    }
    if (models.length === 0) {
        throw new CatalogRefreshError('EMPTY_LISTING', 'the model listing contained no chat-capable models');
    }
    return models;
}
//# sourceMappingURL=listing.js.map