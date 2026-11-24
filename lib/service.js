/**
 * Provider discovery, listing refresh, merge, persistence, and reporting.
 *
 * The service is deliberately independent of Cordis and of the concrete
 * pi-ai adapter: it consumes the public LLM configurable-provider directory
 * and configuration-editor shapes, then writes only each provider's `models`
 * array. A different adapter family that declares those same public facts is
 * refreshed by the same mechanism.
 *
 * @module dsh-model-catalog-refresh/service
 */
import { CatalogRefreshError, describeConfigWriteError, describeError } from './errors.js';
import { assertHeaderSafeCredential, fetchModelListing } from './fetch.js';
import { isListingProtocol } from './listing.js';
import { mergeModelLists } from './merge.js';
import { getAtPath, isRecord } from './raw-config.js';
/** Credential references are POSIX environment-variable names. */
const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Build a failed report with no changes. */
function failedReport(provider, displayName, message, total) {
    return {
        provider,
        displayName,
        status: 'failed',
        added: [],
        removed: [],
        total,
        error: message,
    };
}
/** Run async work with a fixed concurrency ceiling while preserving order. */
async function mapLimit(items, limit, operation) {
    const results = new Array(items.length);
    let cursor = 0;
    const worker = async () => {
        for (;;) {
            const index = cursor;
            cursor += 1;
            if (index >= items.length)
                return;
            const item = items[index];
            if (item === undefined)
                return;
            results[index] = await operation(item);
        }
    };
    const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
}
/** Validate one provider's configured headers. */
function readHeaders(profile) {
    const raw = profile.headers;
    if (raw === undefined)
        return undefined;
    if (!isRecord(raw)) {
        throw new CatalogRefreshError('INVALID_CONFIG', 'the provider "headers" field must be an object');
    }
    const headers = Object.create(null);
    for (const [name, value] of Object.entries(raw)) {
        if (name === '__proto__' || name === 'constructor' || name === 'prototype') {
            throw new CatalogRefreshError('INVALID_CONFIG', `the provider header name "${name}" is not allowed`);
        }
        if (typeof value !== 'string') {
            throw new CatalogRefreshError('INVALID_CONFIG', `the provider header "${name}" must be a string`);
        }
        Object.defineProperty(headers, name, {
            value,
            enumerable: true,
            configurable: true,
            writable: true,
        });
    }
    return Object.keys(headers).length === 0 ? undefined : headers;
}
/**
 * Refresh every eligible provider's model catalog.
 *
 * One run is single-flight: a call while another run is in progress joins the
 * running caller. Only the `models` arrays are written, and only after a
 * non-empty listing and a successful merge. Each provider is isolated, so one
 * endpoint failure never blocks another provider's update.
 */
export class ModelCatalogRefresh {
    deps;
    inFlight;
    abort = new AbortController();
    disposed = false;
    /**
     * @param deps - host services and platform seams.
     */
    constructor(deps) {
        this.deps = deps;
    }
    /** Whether a refresh is currently running. */
    isRefreshing() {
        return this.inFlight !== undefined;
    }
    /** Cancel outstanding HTTP reads; called when the owning plugin unloads. */
    dispose() {
        this.disposed = true;
        this.abort.abort();
    }
    /**
     * Refresh all eligible providers, joining an in-flight run when present.
     * @param reason - why the run started.
     * @returns the completed report; expected failures are reported, not thrown.
     */
    async refresh(reason) {
        if (this.disposed) {
            return {
                reason,
                startedAt: new Date(this.deps.now()).toISOString(),
                durationMs: 0,
                providers: [],
                written: false,
                failed: 0,
                error: 'model catalog refresh is shut down',
            };
        }
        const running = this.inFlight;
        if (running !== undefined)
            return running;
        const run = this.run(reason);
        this.inFlight = run;
        try {
            return await run;
        }
        finally {
            this.inFlight = undefined;
        }
    }
    /** Execute one refresh without the single-flight guard. */
    async run(reason) {
        const started = this.deps.now();
        const reports = [];
        const changes = [];
        let written = false;
        let error;
        try {
            const collection = await this.collectTargets();
            reports.push(...collection.failures);
            const outcomes = await mapLimit(collection.targets, 4, target => this.fetchOne(target));
            for (const outcome of outcomes) {
                reports.push(outcome.report);
                if (outcome.change !== undefined)
                    changes.push(outcome.change);
            }
            if (changes.length > 0) {
                if (this.disposed) {
                    for (const change of changes) {
                        this.markFailed(change, new CatalogRefreshError('REQUEST_FAILED', 'refresh was cancelled before saving'), reports);
                    }
                }
                else {
                    written = await this.persist(changes, reports);
                }
            }
        }
        catch (caught) {
            error = describeError(caught);
        }
        const failed = reports.filter(report => report.status === 'failed').length;
        return {
            reason,
            startedAt: new Date(started).toISOString(),
            durationMs: Math.max(0, this.deps.now() - started),
            providers: reports,
            written,
            failed,
            ...error === undefined ? {} : { error },
        };
    }
    /** Resolve every configured API provider eligible for a catalog refresh. */
    async collectTargets() {
        const directory = this.deps.listConfigurableProviders();
        const configs = new Map(this.deps.describeConfig().map(snapshot => [snapshot.ns, snapshot]));
        const targets = [];
        const failures = [];
        const seen = new Set();
        for (const entry of directory) {
            if (seen.has(entry.provider))
                continue;
            seen.add(entry.provider);
            const snapshot = configs.get(entry.settingsNs);
            if (snapshot === undefined)
                continue;
            const rawProfile = getAtPath(snapshot.raw, entry.settingsPath);
            if (!isRecord(rawProfile)) {
                // A provider defined only below the writable profile layer cannot be
                // rewritten without materializing every schema default into the
                // profile patch. Report it instead of corrupting adjacent settings.
                const inherited = getAtPath(snapshot.effective, entry.settingsPath);
                if (isRecord(inherited) && Array.isArray(inherited.models)) {
                    failures.push(failedReport(entry.provider, entry.displayName, 'the provider is configured outside the writable profile layer; add it to cordis.patch.yml before refreshing', inherited.models.length));
                }
                continue;
            }
            const profile = rawProfile;
            const configuredModels = profile.models;
            // Catalog routes that do not list models get their catalog from the
            // adapter; there is no stored list here to preserve or replace.
            if (configuredModels === undefined)
                continue;
            if (!Array.isArray(configuredModels)) {
                failures.push(failedReport(entry.provider, entry.displayName, 'the provider "models" field must be an array', 0));
                continue;
            }
            const displayName = typeof profile.displayName === 'string' && profile.displayName.length > 0
                ? profile.displayName
                : entry.displayName;
            const api = profile.api;
            // A route without an explicit protocol either speaks the installed
            // catalog's protocol or is not an API route at all; neither can be
            // interrogated safely enough to rewrite the list.
            if (api === undefined)
                continue;
            if (typeof api !== 'string' || api.length === 0) {
                failures.push(failedReport(entry.provider, displayName, 'the provider "api" field must be a non-empty string', configuredModels.length));
                continue;
            }
            if (!isListingProtocol(api)) {
                failures.push(failedReport(entry.provider, displayName, `the provider protocol "${api}" has no model listing this package can read`, configuredModels.length));
                continue;
            }
            let baseURL;
            const configuredBaseURL = profile.baseURL;
            if (configuredBaseURL !== undefined && (typeof configuredBaseURL !== 'string' || configuredBaseURL.length === 0)) {
                failures.push(failedReport(entry.provider, displayName, 'the provider "baseURL" field must be a non-empty string', configuredModels.length));
                continue;
            }
            if (typeof configuredBaseURL === 'string' && configuredBaseURL.length > 0)
                baseURL = configuredBaseURL;
            else if (entry.defaultBaseURL !== undefined && entry.defaultBaseURL.length > 0)
                baseURL = entry.defaultBaseURL;
            else {
                failures.push(failedReport(entry.provider, displayName, 'the provider has no baseURL and no adapter default endpoint', configuredModels.length));
                continue;
            }
            let headers;
            try {
                headers = readHeaders(profile);
            }
            catch (caught) {
                failures.push(failedReport(entry.provider, displayName, describeError(caught), configuredModels.length));
                continue;
            }
            let apiKey;
            const ref = profile.apiKeyEnv;
            if (ref !== undefined) {
                if (typeof ref !== 'string' || !CREDENTIAL_REF.test(ref)) {
                    // Never echo the field: a user may have pasted a key into apiKeyEnv.
                    failures.push(failedReport(entry.provider, displayName, 'the provider "apiKeyEnv" field is not a valid environment-variable name', configuredModels.length));
                    continue;
                }
                try {
                    const resolved = await this.deps.resolveCredential(ref);
                    if (resolved === undefined || resolved.length === 0) {
                        failures.push(failedReport(entry.provider, displayName, 'the provider credential is not set', configuredModels.length));
                        continue;
                    }
                    apiKey = assertHeaderSafeCredential(resolved, ref);
                }
                catch (caught) {
                    failures.push(failedReport(entry.provider, displayName, describeError(caught), configuredModels.length));
                    continue;
                }
            }
            // With no credential reference the request is probed unauthenticated
            // unless a configured header already carries authentication.
            targets.push({
                provider: entry.provider,
                displayName,
                settingsNs: entry.settingsNs,
                modelsPath: [...entry.settingsPath, 'models'],
                baseURL,
                api,
                ...headers === undefined ? {} : { headers },
                ...apiKey === undefined ? {} : { apiKey },
                existingModels: configuredModels,
            });
        }
        return { targets, failures };
    }
    /** Fetch and merge one provider without letting its failure escape. */
    async fetchOne(target) {
        try {
            const discovered = await fetchModelListing({
                baseURL: target.baseURL,
                api: target.api,
                ...target.apiKey === undefined ? {} : { apiKey: target.apiKey },
                ...target.headers === undefined ? {} : { headers: target.headers },
                signal: this.abort.signal,
                timeoutMs: this.deps.requestTimeoutMs,
                maxBytes: this.deps.maxResponseBytes,
                fetchImpl: this.deps.fetchImpl,
            });
            const merged = mergeModelLists(target.existingModels, discovered);
            if (merged.added.length === 0 && merged.removed.length === 0) {
                return {
                    report: {
                        provider: target.provider,
                        displayName: target.displayName,
                        status: 'unchanged',
                        added: [],
                        removed: [],
                        total: merged.models.length,
                    },
                };
            }
            const report = {
                provider: target.provider,
                displayName: target.displayName,
                status: 'updated',
                added: merged.added,
                removed: merged.removed,
                total: merged.models.length,
            };
            return { report, change: { target, models: merged.models, report } };
        }
        catch (caught) {
            return {
                report: failedReport(target.provider, target.displayName, describeError(caught), target.existingModels.length),
            };
        }
    }
    /**
     * Persist merged lists, grouping edits by settings namespace so one
     * namespace is written once. A namespace whose write fails is retried one
     * provider at a time, so one bad model list does not discard the others.
     * @returns whether at least one provider was written.
     */
    async persist(changes, reports) {
        const groups = new Map();
        for (const change of changes) {
            const group = groups.get(change.target.settingsNs);
            if (group === undefined)
                groups.set(change.target.settingsNs, [change]);
            else
                group.push(change);
        }
        let written = false;
        const writtenProviders = new Set();
        for (const [namespace, group] of groups) {
            if (this.disposed)
                break;
            try {
                await this.writeGroup(namespace, group);
                written = true;
                for (const change of group)
                    writtenProviders.add(change.target.provider);
            }
            catch (caught) {
                if (group.length === 1) {
                    const only = group[0];
                    if (only !== undefined)
                        this.markFailed(only, caught, reports);
                    continue;
                }
                // Isolate the rejected provider without abandoning its siblings.
                for (const change of group) {
                    try {
                        await this.writeGroup(namespace, [change]);
                        written = true;
                        writtenProviders.add(change.target.provider);
                    }
                    catch (individual) {
                        this.markFailed(change, individual, reports);
                    }
                }
            }
        }
        if (this.disposed) {
            for (const change of changes) {
                if (writtenProviders.has(change.target.provider))
                    continue;
                this.markFailed(change, new CatalogRefreshError('REQUEST_FAILED', 'refresh was cancelled before saving'), reports);
            }
        }
        if (written && !this.disposed)
            this.emitAdapters();
        return written;
    }
    /** Write one group and announce each provider it contained. */
    async writeGroup(namespace, group) {
        await this.deps.writeModels(namespace, group.map(change => ({
            path: change.target.modelsPath,
            models: change.models,
            expected: change.target.existingModels,
        })));
        for (const change of group)
            this.emitModels(change.target.provider);
    }
    /** Replace one provider's report with a persistence failure. */
    markFailed(change, caught, reports) {
        const index = reports.findIndex(report => report.provider === change.target.provider);
        const failed = failedReport(change.target.provider, change.target.displayName, `could not persist the model list: ${describeConfigWriteError(caught)}`, change.target.existingModels.length);
        if (index >= 0)
            reports[index] = failed;
    }
    /** Emit a per-provider notification without letting consumer failure undo a write. */
    emitModels(provider) {
        try {
            this.deps.emitModelsUpdated(provider);
        }
        catch (caught) {
            this.deps.logger.warn(`model-catalog-refresh: a models-updated listener failed: ${describeError(caught)}`);
        }
    }
    /** Emit the topology notification ACP uses to re-read config options. */
    emitAdapters() {
        try {
            this.deps.emitAdaptersUpdated();
        }
        catch (caught) {
            this.deps.logger.warn(`model-catalog-refresh: an adapters-updated listener failed: ${describeError(caught)}`);
        }
    }
}
//# sourceMappingURL=service.js.map