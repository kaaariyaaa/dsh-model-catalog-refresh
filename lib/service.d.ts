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
import type { RefreshReason, RefreshReport } from './types.js';
/** One configurable provider as the LLM directory reports it. */
export interface ProviderDirectoryEntry {
    /** Provider route key. */
    readonly provider: string;
    /** Human-readable label supplied by the adapter. */
    readonly displayName: string;
    /** Settings namespace that stores this provider's profile. */
    readonly settingsNs: string;
    /** Path from the namespace root to this provider's profile. */
    readonly settingsPath: readonly string[];
    /** Adapter-known default endpoint, when the profile does not override it. */
    readonly defaultBaseURL?: string;
}
/** One profile entry's raw writable layer and resolved effective config. */
export interface ConfigSnapshot {
    /** Profile entry id, also the settings namespace adapters report. */
    readonly ns: string;
    /** Raw profile-layer config, before schema defaults are materialized. */
    readonly raw: unknown;
    /** Effective config the running plugin instance reads. */
    readonly effective: unknown;
}
/** One provider model list to write at a config path. */
export interface ModelListUpdate {
    /** Path from the profile entry's config root to the models array. */
    readonly path: readonly string[];
    /** Merged model entries. */
    readonly models: readonly Record<string, unknown>[];
    /** Stored list this merge was computed from, for a write-time conflict check. */
    readonly expected: readonly unknown[];
}
/** Minimal logger shape used by the service. */
export interface LoggerLike {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
    debug?(message: string): void;
}
/** Host capabilities the service needs. */
export interface RefreshDeps {
    /** Every provider the mounted adapters can activate. */
    listConfigurableProviders(): readonly ProviderDirectoryEntry[];
    /** Raw profile-layer config plus effective config, one entry per namespace. */
    describeConfig(): readonly ConfigSnapshot[];
    /** Persist merged model lists into one profile entry without materializing schema defaults. */
    writeModels(ns: string, updates: readonly ModelListUpdate[]): Promise<void>;
    /** Resolve one credential reference through the host's credential plane. */
    resolveCredential(ref: string): Promise<string | undefined>;
    /** Announce that one provider's advertised models changed. */
    emitModelsUpdated(provider: string): void;
    /** Announce that consumers should re-read provider topology and catalogs. */
    emitAdaptersUpdated(): void;
    /** Host logger; messages never contain secrets. */
    logger: LoggerLike;
    /** Current epoch milliseconds. */
    now(): number;
    /** Fetch implementation, injectable for tests. */
    fetchImpl: typeof fetch;
    /** Per-request deadline. */
    requestTimeoutMs: number;
    /** Reply byte ceiling. */
    maxResponseBytes: number;
}
/**
 * Refresh every eligible provider's model catalog.
 *
 * One run is single-flight: a call while another run is in progress joins the
 * running caller. Only the `models` arrays are written, and only after a
 * non-empty listing and a successful merge. Each provider is isolated, so one
 * endpoint failure never blocks another provider's update.
 */
export declare class ModelCatalogRefresh {
    private readonly deps;
    private inFlight;
    private readonly abort;
    private disposed;
    /**
     * @param deps - host services and platform seams.
     */
    constructor(deps: RefreshDeps);
    /** Whether a refresh is currently running. */
    isRefreshing(): boolean;
    /** Cancel outstanding HTTP reads; called when the owning plugin unloads. */
    dispose(): void;
    /**
     * Refresh all eligible providers, joining an in-flight run when present.
     * @param reason - why the run started.
     * @returns the completed report; expected failures are reported, not thrown.
     */
    refresh(reason: RefreshReason): Promise<RefreshReport>;
    /** Execute one refresh without the single-flight guard. */
    private run;
    /** Resolve every configured API provider eligible for a catalog refresh. */
    private collectTargets;
    /** Fetch and merge one provider without letting its failure escape. */
    private fetchOne;
    /**
     * Persist merged lists, grouping edits by settings namespace so one
     * namespace is written once. A namespace whose write fails is retried one
     * provider at a time, so one bad model list does not discard the others.
     * @returns whether at least one provider was written.
     */
    private persist;
    /** Write one group and announce each provider it contained. */
    private writeGroup;
    /** Replace one provider's report with a persistence failure. */
    private markFailed;
    /** Emit a per-provider notification without letting consumer failure undo a write. */
    private emitModels;
    /** Emit the topology notification ACP uses to re-read config options. */
    private emitAdapters;
}
//# sourceMappingURL=service.d.ts.map