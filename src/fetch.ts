/**
 * One bounded HTTP interrogation of a provider's model-listing endpoint.
 *
 * No retry policy lives here: a refresh is opportunistic, and a failure must
 * leave the stored list untouched. The caller schedules the next attempt.
 *
 * @module dsh-model-catalog-refresh/fetch
 */

import { CatalogRefreshError } from './errors.js'
import {
  anthropicVersion,
  buildListingUrl,
  isAnthropicProtocol,
  parseModelListing,
  sanitizeUrl,
  type ListingProtocol,
} from './listing.js'
import type { DiscoveredModel } from './types.js'

/** Default per-request deadline. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/** Default ceiling on one listing reply, enforced on bytes read rather than Content-Length alone. */
export const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024

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
 * before fetch throws an opaque ByteString error. The value never appears in
 * the diagnostic.
 * @param value - resolved credential.
 * @param ref - credential reference used in the message.
 * @returns the value unchanged.
 */
export function assertHeaderSafeCredential(value: string, ref: string): string {
  if (value.length === 0) {
    throw new CatalogRefreshError('INVALID_CREDENTIAL', `credential ${ref} is empty`)
  }
  // Header values are ByteStrings: code points above U+00FF and control
  // characters are invalid.
  if (/[\u0000-\u001f\u007f]/.test(value) || /[^\u0000-\u00ff]/.test(value)) {
    throw new CatalogRefreshError(
      'INVALID_CREDENTIAL',
      `credential ${ref} contains characters no HTTP header can carry`,
    )
  }
  return value
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

/**
 * Fetch and parse one provider's model catalog.
 * @param options - endpoint, protocol, credential, and bounds.
 * @returns chat-capable models in endpoint order.
 * @throws {CatalogRefreshError} for every expected failure, with a safe message.
 */
export async function fetchModelListing(options: FetchListingOptions): Promise<DiscoveredModel[]> {
  const { url, headers } = buildListingRequest(options)
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const request = requestSignal(options.signal, timeoutMs)
  try {
    let response: Response
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers,
        redirect: 'follow',
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
    let body: unknown
    try {
      body = JSON.parse(text) as unknown
    } catch (error: unknown) {
      throw new CatalogRefreshError(
        'INVALID_RESPONSE',
        `${sanitizeUrl(url)} did not answer with JSON`,
        { cause: error },
      )
    }
    return parseModelListing(body, options.api)
  } finally {
    request.dispose()
  }
}
