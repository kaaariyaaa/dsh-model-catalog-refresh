/**
 * DSH ACP model-catalog refresh plugin.
 *
 * On an ACP profile this mounts one refresh service and one four-hour
 * scheduler. The service discovers eligible API providers from the public
 * configurable-provider directory, interrogates each listing endpoint, merges
 * the result with the stored list, and persists only the `models` array
 * through the Settings service. Server configuration, credentials, headers,
 * and model-level customization stay untouched.
 *
 * The companion entry `dsh-model-catalog-refresh/acp` replaces the ACP app's
 * startup row so `dsh --profile acp model-refresh` can run one refresh and
 * exit without claiming stdio for the ACP bridge.
 *
 * @module dsh-model-catalog-refresh
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-config-editor'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-llm'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'

import { CatalogRefreshError, describeError } from './errors.js'
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from './fetch.js'
import { getAtPath, isRecord, setAtPath } from './raw-config.js'
import { logReport } from './report.js'
import { createRefreshScheduler } from './scheduler.js'
import {
  ModelCatalogRefresh,
  type LoggerLike,
  type ConfigSnapshot,
  type ModelListUpdate,
} from './service.js'
import type { RefreshReason, RefreshReport } from './types.js'

export { ModelCatalogRefresh } from './service.js'
export type {
  ConfigSnapshot,
  LoggerLike,
  ModelListUpdate,
  ProviderDirectoryEntry,
  RefreshDeps,
} from './service.js'
export { mergeModelLists } from './merge.js'
export type { MergeResult } from './merge.js'
export {
  buildListingRequest,
  fetchModelListing,
  type FetchListingOptions,
} from './fetch.js'
export {
  LISTING_PROTOCOLS,
  buildListingUrl,
  parseModelListing,
  sanitizeUrl,
  type ListingProtocol,
} from './listing.js'
export { formatReport, logReport } from './report.js'
export type {
  CatalogModality,
  DiscoveredModel,
  ProviderRefreshReport,
  ProviderRefreshStatus,
  RefreshReason,
  RefreshReport,
} from './types.js'

/** Stable plugin name for diagnostics. */
export const name = 'model-catalog-refresh'

/** The LLM registry is required; the configuration editor and credentials are probed per run. */
export const inject = ['llm']

/** Fixed automatic refresh interval: four hours. */
export const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000

/** Public service the ACP startup entry calls. */
export interface ModelCatalogRefreshApi {
  /**
   * Refresh every eligible provider, joining an in-flight run.
   * @param reason - why the caller is refreshing.
   * @returns the completed report.
   */
  refresh(reason: RefreshReason): Promise<RefreshReport>
  /** Start one post-startup refresh and the four-hour interval. Idempotent. */
  start(): void
  /** Whether a refresh is currently running. */
  isRefreshing(): boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Model catalog refresh service provided by this plugin. */
    modelCatalogRefresh: ModelCatalogRefreshApi
  }
}

/** Read the launch environment without making it a hard dependency. */
function launchEnvironmentValue(ctx: Context, ref: string): string | undefined {
  const environment = ctx.get('launchEnvironment') as
    | { get(name: string): { value: string } | undefined }
    | undefined
  return environment?.get(ref)?.value ?? process.env[ref]
}

/**
 * Mount the refresh service.
 * @param ctx - plugin context with the LLM registry and, on ACP, Settings.
 */
export function apply(ctx: Context): void {
  const logger: LoggerLike = {
    info: message => { ctx.logger.info(message) },
    warn: message => { ctx.logger.warn(message) },
    error: message => { ctx.logger.error(message) },
    debug: message => { ctx.logger.debug(message) },
  }

  const service = new ModelCatalogRefresh({
    listConfigurableProviders: () => ctx.llm.listConfigurableProviders(),
    describeConfig: (): readonly ConfigSnapshot[] => {
      const editor = ctx.get('configEditor')
      if (editor === undefined) {
        throw new CatalogRefreshError(
          'NO_CONFIG_EDITOR',
          'the configuration editor is not mounted; provider configuration cannot be read or saved',
        )
      }
      const rows = new Map(editor.configuration().map(row => [row.entry.options.id, row]))
      return editor.entries().flatMap((entry) => {
        const id = entry.options.id
        if (id === undefined) return []
        const row = rows.get(id)
        return [{
          ns: id,
          raw: row?.override ?? {},
          effective: entry.options.config ?? {},
        }]
      })
    },
    writeModels: async (ns: string, updates: readonly ModelListUpdate[]): Promise<void> => {
      const editor = ctx.get('configEditor')
      if (editor === undefined) {
        throw new CatalogRefreshError(
          'NO_CONFIG_EDITOR',
          'the configuration editor is not mounted; provider configuration cannot be saved',
        )
      }
      const entry = editor.entries().find(row => row.options.id === ns)
      if (entry === undefined) {
        throw new CatalogRefreshError('INVALID_CONFIG', `the profile entry "${ns}" is no longer available`)
      }
      const row = editor.configuration().find(candidate => candidate.entry.options.id === ns)
      const raw = structuredClone(row?.override ?? {})
      if (!isRecord(raw)) {
        throw new CatalogRefreshError('INVALID_CONFIG', `the profile entry "${ns}" does not hold an object config`)
      }
      for (const update of updates) {
        const current = getAtPath(raw, update.path)
        if (JSON.stringify(current) !== update.expected) {
          throw new CatalogRefreshError(
            'INVALID_CONFIG',
            `the model list at "${update.path.join('.')}" changed during this refresh; run it again`,
          )
        }
        try {
          setAtPath(raw, update.path, update.models)
        } catch (error: unknown) {
          throw new CatalogRefreshError('INVALID_CONFIG', describeError(error), { cause: error })
        }
      }
      // edit() validates the complete config, checks that a home patch or
      // command-line overlay does not make the write ineffective, and then
      // reconciles the profile through the normal Loader path.
      await editor.edit(entry, () => raw)
    },
    resolveCredential: async (ref: string): Promise<string | undefined> => {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) {
        const resolved = await credentials.resolve(ref as CredentialRef)
        if (resolved !== undefined && resolved.value.length > 0) return resolved.value
      }
      return launchEnvironmentValue(ctx, ref)
    },
    emitModelsUpdated: (provider: string) => {
      ctx.emit('llm/models-updated', provider)
    },
    emitAdaptersUpdated: () => {
      ctx.emit('llm/adapters-updated')
    },
    logger,
    now: () => Date.now(),
    fetchImpl: (input, init) => globalThis.fetch(input, init),
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
  })

  const runAutomatic = (reason: RefreshReason): void => {
    if (service.isRefreshing()) {
      logger.debug?.('model-catalog-refresh: a refresh is already running; skipping this cycle')
      return
    }
    void service.refresh(reason)
      .then(report => { logReport(report, logger) })
      .catch((error: unknown) => {
        logger.error(`model-catalog-refresh: automatic refresh failed: ${describeError(error)}`)
      })
  }

  // Let the ACP bridge bind stdio and finish startup before the first network
  // read; the refresh itself is asynchronous from that point on. Timers never
  // keep an otherwise idle Harness process alive, so a stopped Harness stops
  // refreshing.
  const scheduler = createRefreshScheduler(
    () => { runAutomatic('startup') },
    () => { runAutomatic('scheduled') },
    REFRESH_INTERVAL_MS,
  )
  const start = (): void => { scheduler.start() }

  ctx.effect(() => () => {
    scheduler.stop()
    service.dispose()
  }, 'model-catalog-refresh.lifecycle')

  ctx.provide('modelCatalogRefresh', {
    refresh: (reason: RefreshReason) => service.refresh(reason),
    start,
    isRefreshing: () => service.isRefreshing(),
  })
}
