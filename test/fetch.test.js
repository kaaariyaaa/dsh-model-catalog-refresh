import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import { assertHeaderSafeCredential, fetchModelListing, nextListingPage } from '../lib/fetch.js'

/** Start a throwaway HTTP server and return its base URL plus a socket tracker. */
async function startServer(handler) {
  const sockets = new Set()
  const server = http.createServer(handler)
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    baseURL: `http://127.0.0.1:${String(address.port)}/v1`,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

test('sends bearer auth, reads capacities, and sanitizes nothing into the result', async (t) => {
  const seen = {}
  const server = await startServer((req, res) => {
    seen.authorization = req.headers.authorization
    seen.userAgent = req.headers['user-agent']
    seen.path = req.url
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      object: 'list',
      data: [{
        id: 'model-a',
        name: 'Model A',
        context_length: 1000000,
        top_provider: { max_completion_tokens: 128000 },
      }],
    }))
  })
  t.after(() => server.close())

  const models = await fetchModelListing({
    baseURL: server.baseURL,
    api: 'openai-completions',
    apiKey: 'test-key-value',
    fetchImpl: fetch,
  })

  assert.equal(seen.authorization, 'Bearer test-key-value')
  assert.match(seen.userAgent, /deepseek-harness\//)
  assert.equal(seen.path, '/v1/models')
  assert.deepEqual(models, [{ id: 'model-a', name: 'Model A', contextWindow: 1000000, maxTokens: 128000 }])
})

test('uses Anthropic headers and the native /v1/models path', async (t) => {
  const seen = {}
  const server = await startServer((req, res) => {
    seen.path = req.url
    seen.apiKey = req.headers['x-api-key']
    seen.version = req.headers['anthropic-version']
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'claude-a', display_name: 'Claude A' }] }))
  })
  t.after(() => server.close())

  const models = await fetchModelListing({
    baseURL: server.baseURL,
    api: 'anthropic-messages',
    apiKey: 'anthropic-key',
    fetchImpl: fetch,
  })

  assert.equal(seen.path, '/v1/models?limit=1000')
  assert.equal(seen.apiKey, 'anthropic-key')
  assert.equal(seen.version, '2023-06-01')
  assert.deepEqual(models, [{ id: 'claude-a', name: 'Claude A' }])
})

test('a 401 names the status and never the credential', async (t) => {
  const server = await startServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end('{"error":"unauthorized"}')
  })
  t.after(() => server.close())

  await assert.rejects(
    fetchModelListing({
      baseURL: server.baseURL,
      api: 'openai-completions',
      apiKey: 'do-not-log-this-key',
      fetchImpl: fetch,
    }),
    (error) => {
      assert.equal(error.code, 'HTTP_ERROR')
      assert.match(error.message, /HTTP 401/)
      assert.match(error.message, /check the API key/)
      assert.doesNotMatch(error.message, /do-not-log-this-key/)
      return true
    },
  )
})

test('a slow endpoint hits the deadline', async (t) => {
  const server = await startServer(() => {
    // Deliberately never answer.
  })
  t.after(() => server.close())

  await assert.rejects(
    fetchModelListing({
      baseURL: server.baseURL,
      api: 'openai-completions',
      timeoutMs: 40,
      fetchImpl: fetch,
    }),
    (error) => error.code === 'TIMEOUT',
  )
})

test('a reply above the byte ceiling is refused', async (t) => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'a', description: 'x'.repeat(500) }] }))
  })
  t.after(() => server.close())

  await assert.rejects(
    fetchModelListing({
      baseURL: server.baseURL,
      api: 'openai-completions',
      maxBytes: 80,
      fetchImpl: fetch,
    }),
    (error) => error.code === 'INVALID_RESPONSE' && /more than 80 bytes/.test(error.message),
  )
})

test('non-JSON is refused', async (t) => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('not json')
  })
  t.after(() => server.close())

  await assert.rejects(
    fetchModelListing({
      baseURL: server.baseURL,
      api: 'openai-completions',
      fetchImpl: fetch,
    }),
    (error) => error.code === 'INVALID_RESPONSE' && /did not answer with JSON/.test(error.message),
  )
})

test('an unreachable host is a safe request failure', async () => {
  await assert.rejects(
    fetchModelListing({
      baseURL: 'http://127.0.0.1:1/v1',
      api: 'openai-completions',
      timeoutMs: 200,
      fetchImpl: fetch,
    }),
    (error) => error.code === 'REQUEST_FAILED' && /could not reach/.test(error.message),
  )
})


test('Anthropic pages with has_more and last_id are followed to completion', async (t) => {
  const server = await startServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    res.writeHead(200, { 'content-type': 'application/json' })
    if (url.searchParams.get('after_id') === 'page-1') {
      res.end(JSON.stringify({
        data: [{ id: 'claude-b', display_name: 'Claude B' }],
        has_more: false,
      }))
      return
    }
    res.end(JSON.stringify({
      data: [{ id: 'claude-a', display_name: 'Claude A' }],
      has_more: true,
      last_id: 'page-1',
    }))
  })
  t.after(() => server.close())

  const models = await fetchModelListing({
    baseURL: server.baseURL,
    api: 'anthropic-messages',
    fetchImpl: fetch,
  })
  assert.deepEqual(models, [
    { id: 'claude-a', name: 'Claude A' },
    { id: 'claude-b', name: 'Claude B' },
  ])
})

test('Gemini nextPageToken pages are followed to completion', async (t) => {
  const server = await startServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    res.writeHead(200, { 'content-type': 'application/json' })
    if (url.searchParams.get('pageToken') === 'next-page') {
      res.end(JSON.stringify({
        models: [{ name: 'models/gemini-b', displayName: 'Gemini B' }],
      }))
      return
    }
    res.end(JSON.stringify({
      models: [{ name: 'models/gemini-a', displayName: 'Gemini A' }],
      nextPageToken: 'next-page',
    }))
  })
  t.after(() => server.close())

  const models = await fetchModelListing({
    baseURL: server.baseURL,
    api: 'google-generative-ai',
    fetchImpl: fetch,
  })
  assert.deepEqual(models, [
    { id: 'gemini-a', name: 'Gemini A' },
    { id: 'gemini-b', name: 'Gemini B' },
  ])
})

test('OpenAI-compatible pagination is refused rather than merged partially', async (t) => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'only-page' }], has_more: true }))
  })
  t.after(() => server.close())

  await assert.rejects(
    fetchModelListing({
      baseURL: server.baseURL,
      api: 'openai-completions',
      fetchImpl: fetch,
    }),
    (error) => error.code === 'INVALID_RESPONSE' && /refusing a partial refresh/.test(error.message),
  )
})

test('nextListingPage returns cursors only for supported protocols', () => {
  const anthropic = new URL('https://api.example/v1/models?limit=1000')
  assert.equal(
    nextListingPage({ has_more: true, last_id: 'abc' }, 'anthropic-messages', anthropic).href,
    'https://api.example/v1/models?limit=1000&after_id=abc',
  )
  assert.equal(nextListingPage({ has_more: false }, 'anthropic-messages', anthropic), undefined)
  const gemini = new URL('https://api.example/v1beta/models?pageSize=1000')
  assert.equal(
    nextListingPage({ nextPageToken: 'tok' }, 'google-generative-ai', gemini).href,
    'https://api.example/v1beta/models?pageSize=1000&pageToken=tok',
  )
  assert.throws(
    () => nextListingPage({ next: 'https://evil.example/models' }, 'openai-completions', anthropic),
    /refusing a partial refresh/,
  )
})

test('a repeated pagination cursor is refused', () => {
  const current = new URL('https://api.example/v1/models?limit=1000&after_id=abc')
  assert.throws(
    () => nextListingPage({ has_more: true, last_id: 'abc' }, 'anthropic-messages', current),
    /repeated the same/,
  )
})


test('credentials are trimmed and unsafe header values are refused', () => {
  assert.equal(assertHeaderSafeCredential('  test-key  ', 'TEST_KEY'), 'test-key')
  assert.throws(
    () => assertHeaderSafeCredential('   ', 'TEST_KEY'),
    (error) => error.code === 'INVALID_CREDENTIAL' && /is empty/.test(error.message),
  )
  assert.throws(
    () => assertHeaderSafeCredential('key\nheader', 'TEST_KEY'),
    (error) => error.code === 'INVALID_CREDENTIAL' && /no HTTP header/.test(error.message),
  )
  assert.doesNotMatch(
    (() => {
      try { assertHeaderSafeCredential('bad-key\nvalue', 'TEST_KEY') } catch (error) { return error.message }
      return ''
    })(),
    /bad-key/,
  )
})


test('a cross-origin redirect is refused before any credential header can follow it', async (t) => {
  let attackerHits = 0
  const attacker = await startServer((_req, res) => {
    attackerHits += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"data":[{"id":"stolen"}]}')
  })
  t.after(() => attacker.close())
  const redirector = await startServer((_req, res) => {
    res.writeHead(302, { location: `${attacker.baseURL}/models` })
    res.end()
  })
  t.after(() => redirector.close())

  await assert.rejects(
    fetchModelListing({
      baseURL: redirector.baseURL,
      api: 'openai-completions',
      apiKey: 'redirect-secret',
      fetchImpl: fetch,
    }),
    (error) => {
      assert.equal(error.code, 'REQUEST_FAILED')
      assert.doesNotMatch(error.message, /redirect-secret/)
      return true
    },
  )
  assert.equal(attackerHits, 0)
})


test('a chunked reply above the byte ceiling is refused without a Content-Length hint', async (t) => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write('{"data":[{"id":"a","description":"')
    res.write('x'.repeat(500))
    res.end('"}]}')
  })
  t.after(() => server.close())

  await assert.rejects(
    fetchModelListing({
      baseURL: server.baseURL,
      api: 'openai-completions',
      maxBytes: 80,
      fetchImpl: fetch,
    }),
    (error) => error.code === 'INVALID_RESPONSE' && /more than 80 bytes/.test(error.message),
  )
})
