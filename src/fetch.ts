/**
 * One bounded, paginated HTTP interrogation of a provider's model-listing
 * endpoint.
 *
 * No retry policy lives here: a refresh is opportunistic, and a failure must
 * leave the stored list untouched. The caller schedules the next attempt.
 *
 * @module dsh-model-catalog-refresh/fetch
 */

import { attributionHeaders } from '@deepseek-ai/dsh-llm'

import { CatalogRefreshError } from './errors.js'
import {
  anthropicVersion,
  buildListingUrl,
  isAnthropicProtocol,
  listingRows,
  parseModelListing,
  sanitizeUrl,
  type ListingProtocol,
} from './listing.js'
import type { DiscoveredModel } from './types.js'

/** Default per-request deadline. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/** Default ceiling on one listing reply, enforced on bytes read rather than Content-Length alone. */
export const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/** Upper bound on listing pages read for one provider. */
export const MAX_LISTING_PAGES = 20

/** Inputs for one listing request. */
export interface FetchListingOptions {
  /** Configured provider endpoint. */
  readonly baseURL: string
  /** Supported wire protocol. */
  readonly api: ListingProtocol
  /** Credential value, already resolved; never logged. */
  readonly apiKey?: string
  /** Provider-configured request headers. */
  readonly headers?: Readonly<Record<string, string>>
  /** Cancellation from plugin disposal or a caller. */
  readonly signal?: AbortSignal
  /** Per-request deadline. */
  readonly timeoutMs?: number
  /** Reply byte ceiling. */
  readonly maxBytes?: number
  /** Injectable fetch for tests. */
  readonly fetchImpl?: typeof fetch
  /** User-Agent component; absent leaves the runtime default. */
  readonly userAgent?: string
}

/** Resolved request facts used by tests and diagnostics. */
export interface ListingRequest {
  readonly url: URL
  readonly headers: Headers
}

/**
 * Accept a credential that can be sent as an HTTP header value, or refuse it
 * before fetch throws an opaque ByteString error. Surrounding whitespace is
 * trimmed, matching DSH's own credential normalization. The value never
 * appears in the diagnostic.
 * @param value - resolved credential.
 * @param ref - credential reference used in the message.
 * @returns the trimmed, usable value.
 */
export function assertHeaderSafeCredential(value: string, ref: string): string {
  // The reference is deliberately not echoed: a user may have pasted a key
  // into apiKeyEnv, and that string must not reach a report.
  void ref
  const normalized = value.trim()
  if (normalized.length === 0) {
    throw new CatalogRefreshError('INVALID_CREDENTIAL', 'the provider credential is empty')
  }
  // Header values are ByteStrings: code points above U+00FF and control
  // characters are invalid.
  if (/[\u0000-\u001f\u007f]/.test(normalized) || /[^\u0000-\u00ff]/.test(normalized)) {
    throw new CatalogRefreshError(
      'INVALID_CREDENTIAL',
      'the provider credential contains characters no HTTP header can carry',
    )
  }
  return normalized
}

/**
 * Build the request URL and headers for one listing.
 * @param options - endpoint, protocol, and credential inputs.
 * @returns the URL and a detached header set.
 * @throws {CatalogRefreshError} for invalid configuration or an unusable credential.
 */
export function buildListingRequest(options: FetchListingOptions): ListingRequest {
  const url = buildListingUrl(options.baseURL, options.api)
  const headers = new Headers()
  try {
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      headers.set(name, value)
    }
    headers.set('accept', 'application/json')
    if (options.userAgent !== undefined && options.userAgent.length > 0) {
      headers.set('user-agent', options.userAgent)
    }
    if (options.apiKey !== undefined) {
      const key = options.apiKey
      if (isAnthropicProtocol(options.api)) {
        headers.set('x-api-key', key)
        if (!headers.has('anthropic-version')) headers.set('anthropic-version', anthropicVersion())
      } else if (options.api === 'google-generative-ai') {
        headers.set('x-goog-api-key', key)
      } else {
        headers.set('authorization', `Bearer ${key}`)
      }
    } else if (isAnthropicProtocol(options.api) && !headers.has('anthropic-version')) {
      headers.set('anthropic-version', anthropicVersion())
    }
    // Harness attribution is required on every provider request and wins any
    // conflicting configured header, as it does in the pi-ai adapter.
    for (const [name, value] of Object.entries(attributionHeaders())) headers.set(name, value)
  } catch (error: unknown) {
    throw new CatalogRefreshError(
      'INVALID_CONFIG',
      'a provider header name or value is not valid for an HTTP request',
      { cause: error },
    )
  }
  return { url, headers }
}

/** Read a response body while enforcing a byte ceiling on the bytes actually read. */
async function readBounded(response: Response, url: string, maxBytes: number): Promise<string> {
  const oversized = (): CatalogRefreshError => new CatalogRefreshError(
    'INVALID_RESPONSE',
    `${sanitizeUrl(url)} answered with more than ${String(maxBytes)} bytes`,
  )
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > maxBytes) {
    if (response.body !== null) await response.body.cancel().catch(() => {})
    throw oversized()
  }
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw oversized()
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {
      // A completed or abandoned read is already decided; cancellation is cleanup.
    })
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

/** Combine a caller signal with a per-request deadline. */
function requestSignal(caller: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal
  timedOut: () => boolean
  dispose: () => void
} {
  const controller = new AbortController()
  let timedOut = false
  const onCallerAbort = (): void => {
    controller.abort(caller?.reason)
  }
  if (caller?.aborted === true) onCallerAbort()
  else caller?.addEventListener('abort', onCallerAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error('request timeout'))
  }, timeoutMs)
  timer.unref?.()
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer)
      caller?.removeEventListener('abort', onCallerAbort)
    },
  }
}

/** A plain data object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Describe the next page of one reply.
 *
 * Anthropic and Google publish a usable cursor, so their pages are followed.
 * OpenAI-compatible gateways have no single pagination contract; a reply that
 * says more rows exist is refused instead of merging a partial catalog and
 * deleting the rest, because an unadvertised page cannot be distinguished from
 * a retired model.
 * @param body - one decoded reply.
 * @param api - protocol that produced it.
 * @param current - URL that produced the reply.
 * @returns the next page URL, or undefined when the listing is complete.
 * @throws {CatalogRefreshError} when more pages are claimed but cannot be followed safely.
 */
export function nextListingPage(body: unknown, api: ListingProtocol, current: URL): URL | undefined {
  if (!isRecord(body)) return undefined
  if (api === 'anthropic-messages') {
    if (body.has_more !== true) return undefined
    const lastId = body.last_id
    if (typeof lastId !== 'string' || lastId.length === 0) {
      throw new CatalogRefreshError(
        'INVALID_RESPONSE',
        `${sanitizeUrl(current)} reports more Anthropic models but supplies no last_id; refusing a partial refresh`,
      )
    }
    if (current.searchParams.get('after_id') === lastId) {
      throw new CatalogRefreshError('INVALID_RESPONSE', `${sanitizeUrl(current)} repeated the same Anthropic page cursor`)
    }
    const next = new URL(current)
    next.searchParams.set('after_id', lastId)
    return next
  }
  if (api === 'google-generative-ai') {
    const token = body.nextPageToken
    if (token === undefined || token === null || token === '') return undefined
    if (typeof token !== 'string') {
      throw new CatalogRefreshError(
        'INVALID_RESPONSE',
        `${sanitizeUrl(current)} returned a non-string nextPageToken; refusing a partial refresh`,
      )
    }
    if (current.searchParams.get('pageToken') === token) {
      throw new CatalogRefreshError('INVALID_RESPONSE', `${sanitizeUrl(current)} repeated the same Gemini page token`)
    }
    const next = new URL(current)
    next.searchParams.set('pageToken', token)
    return next
  }
  const claimsMore = body.has_more === true
  const cursor = body.next ?? body.next_page_token ?? body.nextPageToken
  if (claimsMore || (typeof cursor === 'string' && cursor.length > 0)) {
    throw new CatalogRefreshError(
      'INVALID_RESPONSE',
      `${sanitizeUrl(current)} reports more pages, but this protocol has no safe pagination contract; refusing a partial refresh`,
    )
  }
  return undefined
}

/** Combine decoded pages into the one body shape the parser already reads. */
function combinedBody(pages: readonly unknown[], api: ListingProtocol): unknown {
  const rows = pages.flatMap(page => listingRows(page))
  return api === 'google-generative-ai' ? { models: rows } : { data: rows }
}

/** Fetch and decode one listing page. */
async function fetchJsonPage(
  url: URL,
  headers: Headers,
  options: FetchListingOptions,
  timeoutMs: number,
  maxBytes: number,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const request = requestSignal(options.signal, timeoutMs)
  try {
    let response: Response
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers,
        // A cross-origin redirect would carry x-api-key / x-goog-api-key
        // past undici's Authorization-only stripping. Refuse redirects
        // instead of following one to an attacker-controlled host.
        redirect: 'error',
        signal: request.signal,
      })
    } catch (error: unknown) {
      if (options.signal?.aborted === true) {
        throw new CatalogRefreshError('REQUEST_FAILED', 'model listing request was cancelled', { cause: error })
      }
      if (request.timedOut()) {
        throw new CatalogRefreshError(
          'TIMEOUT',
          `${sanitizeUrl(url)} did not answer within ${String(timeoutMs)}ms`,
          { cause: error },
        )
      }
      throw new CatalogRefreshError(
        'REQUEST_FAILED',
        `could not reach ${sanitizeUrl(url)}`,
        { cause: error },
      )
    }
    if (!response.ok) {
      if (response.body !== null) await response.body.cancel().catch(() => {})
      throw new CatalogRefreshError(
        'HTTP_ERROR',
        `${sanitizeUrl(url)} answered HTTP ${String(response.status)}`
          + (response.status === 401 || response.status === 403 ? '; check the API key' : ''),
      )
    }
    let text: string
    try {
      text = await readBounded(response, url.toString(), maxBytes)
    } catch (error: unknown) {
      if (options.signal?.aborted === true) {
        throw new CatalogRefreshError('REQUEST_FAILED', 'model listing request was cancelled', { cause: error })
      }
      if (request.timedOut()) {
        throw new CatalogRefreshError(
          'TIMEOUT',
          `${sanitizeUrl(url)} did not finish within ${String(timeoutMs)}ms`,
          { cause: error },
        )
      }
      throw error
    }
    try {
      return JSON.parse(text) as unknown
    } catch (error: unknown) {
      throw new CatalogRefreshError(
        'INVALID_RESPONSE',
        `${sanitizeUrl(url)} did not answer with JSON`,
        { cause: error },
      )
    }
  } finally {
    request.dispose()
  }
}

/**
 * Fetch and parse one provider's model catalog, following the pagination
 * contracts this package can follow safely.
 * @param options - endpoint, protocol, credential, and bounds.
 * @returns chat-capable models in endpoint order.
 * @throws {CatalogRefreshError} for every expected failure, with a safe message.
 */
export async function fetchModelListing(options: FetchListingOptions): Promise<DiscoveredModel[]> {
  const { url, headers } = buildListingRequest(options)
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const pages: unknown[] = []
  const seen = new Set<string>()
  let current = url
  for (let page = 0; page < MAX_LISTING_PAGES; page++) {
    if (seen.has(current.href)) {
      throw new CatalogRefreshError('INVALID_RESPONSE', `${sanitizeUrl(current)} repeated a page URL`)
    }
    seen.add(current.href)
    const body = await fetchJsonPage(current, headers, options, timeoutMs, maxBytes, fetchImpl)
    pages.push(body)
    const next = nextListingPage(body, options.api, current)
    if (next === undefined) return parseModelListing(combinedBody(pages, options.api), options.api)
    current = next
  }
  throw new CatalogRefreshError(
    'INVALID_RESPONSE',
    `${sanitizeUrl(url)} exceeded ${String(MAX_LISTING_PAGES)} model-listing pages; refusing a partial refresh`,
  )
}
