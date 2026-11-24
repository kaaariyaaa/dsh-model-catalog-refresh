import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import { fetchModelListing } from '../lib/fetch.js'

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
