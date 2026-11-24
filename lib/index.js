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
import { isDeepStrictEqual } from 'node:util';
import { CatalogRefreshError, describeError } from './errors.js';
import { DEFAULT_MAX_RESPONSE_BYTES, DEFAULT_REQUEST_TIMEOUT_MS, } from './fetch.js';
import { getAtPath, isRecord, setAtPath } from './raw-config.js';
import { logReport } from './report.js';
import { createRefreshScheduler } from './scheduler.js';
import { ModelCatalogRefresh, } from './service.js';
export { ModelCatalogRefresh } from './service.js';
export { mergeModelLists } from './merge.js';
export { buildListingRequest, fetchModelListing, } from './fetch.js';
export { LISTING_PROTOCOLS, buildListingUrl, parseModelListing, sanitizeUrl, } from './listing.js';
export { formatReport, logReport } from './report.js';
/** Stable plugin name for diagnostics. */
export const name = 'model-catalog-refresh';
/** The LLM registry is required; the configuration editor and credentials are probed per run. */
export const inject = ['llm'];
/** Fixed automatic refresh interval: four hours. */
export const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** Read the launch environment without making it a hard dependency. */
function launchEnvironmentValue(ctx, ref) {
    const environment = ctx.get('launchEnvironment');
    return environment?.get(ref)?.value ?? process.env[ref];
}
/**
 * Mount the refresh service.
 * @param ctx - plugin context with the LLM registry and a writable profile.
 */
export function apply(ctx) {
    const logger = {
        info: message => { ctx.logger.info(message); },
        warn: message => { ctx.logger.warn(message); },
        error: message => { ctx.logger.error(message); },
        debug: message => { ctx.logger.debug(message); },
    };
    const service = new ModelCatalogRefresh({
        listConfigurableProviders: () => ctx.llm.listConfigurableProviders(),
        describeConfig: () => {
            const editor = ctx.get('configEditor');
            if (editor === undefined) {
                throw new CatalogRefreshError('NO_CONFIG_EDITOR', 'the configuration editor is not mounted; provider configuration cannot be read or saved');
            }
            const rows = new Map(editor.configuration().map(row => [row.entry.options.id, row]));
            return editor.entries().flatMap((entry) => {
                const id = entry.options.id;
                if (id === undefined)
                    return [];
                const row = rows.get(id);
                return [{
                        ns: id,
                        raw: row?.override ?? {},
                        effective: entry.options.config ?? {},
                    }];
            });
        },
        writeModels: async (ns, updates) => {
            const editor = ctx.get('configEditor');
            if (editor === undefined) {
                throw new CatalogRefreshError('NO_CONFIG_EDITOR', 'the configuration editor is not mounted; provider configuration cannot be saved');
            }
            const entry = editor.entries().find(row => row.options.id === ns);
            if (entry === undefined) {
                throw new CatalogRefreshError('INVALID_CONFIG', `the profile entry "${ns}" is no longer available`);
            }
            // edit() runs this callback under the profile's file lock, after
            // reconciling any edits another process made. Applying the model paths
            // to that fresh current config, rather than to a pre-lock snapshot,
            // preserves concurrent changes to other providers and settings.
            await editor.edit(entry, (current) => {
                if (!isRecord(current)) {
                    throw new CatalogRefreshError('INVALID_CONFIG', `the profile entry "${ns}" does not hold an object config`);
                }
                const next = structuredClone(current);
                for (const update of updates) {
                    const actual = getAtPath(next, update.path);
                    if (!isDeepStrictEqual(actual, update.expected)) {
                        throw new CatalogRefreshError('INVALID_CONFIG', `the model list at "${update.path.join('.')}" changed during this refresh; run it again`);
                    }
                    try {
                        setAtPath(next, update.path, update.models);
                    }
                    catch (error) {
                        throw new CatalogRefreshError('INVALID_CONFIG', describeError(error), { cause: error });
                    }
                }
                return next;
            });
        },
        resolveCredential: async (ref) => {
            const credentials = ctx.get('credentials');
            if (credentials !== undefined) {
                const resolved = await credentials.resolve(ref);
                if (resolved !== undefined && resolved.value.length > 0)
                    return resolved.value;
            }
            return launchEnvironmentValue(ctx, ref);
        },
        emitModelsUpdated: (provider) => {
            ctx.emit('llm/models-updated', provider);
        },
        emitAdaptersUpdated: () => {
            ctx.emit('llm/adapters-updated');
        },
        logger,
        now: () => Date.now(),
        fetchImpl: (input, init) => globalThis.fetch(input, init),
        requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
        maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
    });
    const runAutomatic = (reason) => {
        if (service.isRefreshing()) {
            logger.debug?.('model-catalog-refresh: a refresh is already running; skipping this cycle');
            return;
        }
        void service.refresh(reason)
            .then(report => { logReport(report, logger); })
            .catch((error) => {
            logger.error(`model-catalog-refresh: automatic refresh failed: ${describeError(error)}`);
        });
    };
    // Let the ACP bridge bind stdio and finish startup before the first network
    // read; the refresh itself is asynchronous from that point on. Timers never
    // keep an otherwise idle Harness process alive, so a stopped Harness stops
    // refreshing.
    const scheduler = createRefreshScheduler(() => { runAutomatic('startup'); }, () => { runAutomatic('scheduled'); }, REFRESH_INTERVAL_MS);
    const start = () => { scheduler.start(); };
    ctx.effect(() => () => {
        scheduler.stop();
        service.dispose();
    }, 'model-catalog-refresh.lifecycle');
    ctx.provide('modelCatalogRefresh', {
        refresh: (reason) => service.refresh(reason),
        start,
        isRefreshing: () => service.isRefreshing(),
    });
}
//# sourceMappingURL=index.js.map