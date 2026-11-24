/**
 * Shared result types for a model-catalog refresh.
 *
 * @module dsh-model-catalog-refresh/types
 */

/** Why a refresh ran. */
export type RefreshReason = 'manual' | 'scheduled' | 'startup'

/** Request modalities a listing may disclose. */
export type CatalogModality = 'image' | 'text'

/** One chat-capable model read from a provider's listing endpoint. */
export interface DiscoveredModel {
  /** Model id the endpoint accepts unchanged. */
  readonly id: string
  /** Display label supplied by the endpoint. */
  readonly name?: string
  /** Maximum combined request and response context, when disclosed. */
  readonly contextWindow?: number
  /** Maximum output tokens, when disclosed. */
  readonly maxTokens?: number
  /** Explicitly disclosed input modalities; absent means the listing said nothing. */
  readonly input?: readonly CatalogModality[]
}

/** State of one provider in a refresh report. */
export type ProviderRefreshStatus = 'failed' | 'unchanged' | 'updated'

/** Outcome for one provider. */
export interface ProviderRefreshReport {
  /** Provider route key. */
  readonly provider: string
  /** Human-readable provider label. */
  readonly displayName: string
  /** Final state after fetching, merging, and persistence. */
  status: ProviderRefreshStatus
  /** Model ids added by this refresh. */
  readonly added: readonly string[]
  /** Model ids removed by this refresh. */
  readonly removed: readonly string[]
  /** Total models the provider serves after this refresh. */
  readonly total: number
  /** Safe failure detail; present only for `failed`. */
  error?: string
}

/** Aggregate result of one refresh run. */
export interface RefreshReport {
  /** Why the run started. */
  readonly reason: RefreshReason
  /** ISO timestamp for the start of the run. */
  readonly startedAt: string
  /** Wall-clock duration in milliseconds. */
  durationMs: number
  /** One entry per eligible provider, in directory order. */
  readonly providers: ProviderRefreshReport[]
  /** Whether any provider's model list was persisted. */
  written: boolean
  /** Number of providers that failed. */
  failed: number
  /** A run-wide failure such as a missing settings service. */
  error?: string
}

/** Settings path edit used to persist one provider's model list. */
export type SettingsPathOp =
  | { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }
  | { readonly op: 'unset'; readonly path: readonly string[] }
