import assert from 'node:assert/strict'
import test from 'node:test'

import { ModelCatalogRefresh } from '../lib/service.js'

const NS = 'llm-pi-ai'

function providerProfile(overrides = {}) {
  return {
    api: 'openai-completions',
    baseURL: 'https://gateway.example/v1',
    apiKeyEnv: 'GATEWAY_KEY',
    models: [{ id: 'keep', name: 'Keep', contextWindow: 123 }, { id: 'old' }],
    ...overrides,
  }
}

function directoryEntry(provider, overrides = {}) {
  return {
    provider,
    displayName: provider,
    settingsNs: NS,
    settingsPath: ['providers', provider],
    ...overrides,
  }
}

function configSnapshot(providers) {
  return [{ ns: NS, raw: { providers }, effective: { providers } }]
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function baseDeps(overrides = {}) {
  const events = []
  const writes = []
  const logger = { info() {}, warn() {}, error() {}, debug() {} }
  return {
    events,
    writes,
    deps: {
      listConfigurableProviders: () => [],
      describeConfig: () => [],
      writeModels: async (ns, updates) => { writes.push({ ns, updates }) },
      resolveCredential: async () => 'secret-key',
      emitModelsUpdated: (provider) => { events.push(['models', provider]) },
      emitAdaptersUpdated: () => { events.push(['adapters']) },
      logger,
      now: () => 1000,
      fetchImpl: async () => jsonResponse({ data: [] }),
      requestTimeoutMs: 1000,
      maxResponseBytes: 1024 * 1024,
      ...overrides,
    },
  }
}

test('updates one provider, preserves existing entries, and emits refresh events', async () => {
  const harness = baseDeps({
    listConfigurableProviders: () => [directoryEntry('gateway')],
    describeConfig: () => configSnapshot({ gateway: providerProfile() }),
    fetchImpl: async (url, init) => {
      assert.equal(String(url), 'https://gateway.example/v1/models')
      assert.equal(init.headers.get('authorization'), 'Bearer secret-key')
      return jsonResponse({
        object: 'list',
        data: [
          { id: 'keep', name: 'Remote Keep', context_length: 999 },
          { id: 'new', name: 'New Model', context_length: 65536, top_provider: { max_completion_tokens: 4096 } },
          { id: 'embed', type: 'embedding' },
        ],
      })
    },
  })
  const service = new ModelCatalogRefresh(harness.deps)
  const report = await service.refresh('manual')

  assert.equal(report.error, undefined)
  assert.equal(report.failed, 0)
  assert.equal(report.written, true)
  assert.equal(report.providers.length, 1)
  assert.equal(report.providers[0].status, 'updated')
  assert.deepEqual(report.providers[0].added, ['new'])
  assert.deepEqual(report.providers[0].removed, ['old'])
  assert.equal(report.providers[0].total, 2)

  assert.equal(harness.writes.length, 1)
  assert.equal(harness.writes[0].ns, NS)
  assert.deepEqual(harness.writes[0].updates, [{
    path: ['providers', 'gateway', 'models'],
    models: [
      { id: 'keep', name: 'Keep', contextWindow: 123 },
      { id: 'new', name: 'New Model', contextWindow: 65536, maxTokens: 4096 },
    ],
    expected: JSON.stringify([{ id: 'keep', name: 'Keep', contextWindow: 123 }, { id: 'old' }]),
  }])
  assert.deepEqual(harness.events, [['models', 'gateway'], ['adapters']])
  assert.doesNotMatch(JSON.stringify(report), /secret-key/)
  assert.doesNotMatch(JSON.stringify(harness.writes), /secret-key/)
})

test('a failing provider does not block another provider update', async () => {
  const harness = baseDeps({
    listConfigurableProviders: () => [directoryEntry('broken'), directoryEntry('working')],
    describeConfig: () => configSnapshot({
      broken: providerProfile({ baseURL: 'https://gateway.example/broken' }),
      working: providerProfile({ baseURL: 'https://gateway.example/working', models: [{ id: 'old' }] }),
    }),
    fetchImpl: async (url) => {
      if (String(url).includes('/broken/')) {
        return jsonResponse({ error: 'boom' }, 500)
      }
      return jsonResponse({ data: [{ id: 'new' }] })
    },
  })
  const service = new ModelCatalogRefresh(harness.deps)
  const report = await service.refresh('manual')

  assert.equal(report.failed, 1)
  assert.equal(report.providers[0].status, 'failed')
  assert.match(report.providers[0].error, /HTTP 500/)
  assert.equal(report.providers[1].status, 'updated')
  assert.equal(harness.writes.length, 1)
  assert.deepEqual(harness.events, [['models', 'working'], ['adapters']])
})

test('an empty listing keeps the stored list and writes nothing', async () => {
  const harness = baseDeps({
    listConfigurableProviders: () => [directoryEntry('gateway')],
    describeConfig: () => configSnapshot({ gateway: providerProfile() }),
    fetchImpl: async () => jsonResponse({ object: 'list', data: [] }),
  })
  const service = new ModelCatalogRefresh(harness.deps)
  const report = await service.refresh('manual')

  assert.equal(report.written, false)
  assert.equal(report.failed, 1)
  assert.match(report.providers[0].error, /no chat-capable models/)
  assert.deepEqual(harness.writes, [])
  assert.deepEqual(harness.events, [])
})

test('a missing credential is reported before any network request', async () => {
  let fetched = false
  const harness = baseDeps({
    listConfigurableProviders: () => [directoryEntry('gateway')],
    describeConfig: () => configSnapshot({ gateway: providerProfile() }),
    resolveCredential: async () => undefined,
    fetchImpl: async () => {
      fetched = true
      return jsonResponse({ data: [{ id: 'x' }] })
    },
  })
  const service = new ModelCatalogRefresh(harness.deps)
  const report = await service.refresh('manual')

  assert.equal(fetched, false)
  assert.equal(report.failed, 1)
  assert.match(report.providers[0].error, /GATEWAY_KEY is not set/)
  assert.deepEqual(harness.writes, [])
})

test('an unsupported protocol is reported without a network request', async () => {
  let fetched = false
  const harness = baseDeps({
    listConfigurableProviders: () => [directoryEntry('gateway')],
    describeConfig: () => configSnapshot({ gateway: providerProfile({ api: 'bedrock-converse' }) }),
    fetchImpl: async () => {
      fetched = true
      return jsonResponse({ data: [{ id: 'x' }] })
    },
  })
  const service = new ModelCatalogRefresh(harness.deps)
  const report = await service.refresh('manual')

  assert.equal(fetched, false)
  assert.equal(report.failed, 1)
  assert.match(report.providers[0].error, /no model listing/)
})

test('a persistence failure keeps the old list and suppresses change events', async () => {
  const harness = baseDeps({
    listConfigurableProviders: () => [directoryEntry('gateway')],
    describeConfig: () => configSnapshot({ gateway: providerProfile() }),
    fetchImpl: async () => jsonResponse({ data: [{ id: 'new' }] }),
    writeModels: async () => { throw new Error('configuration write refused') },
  })
  const service = new ModelCatalogRefresh(harness.deps)
  const report = await service.refresh('manual')

  assert.equal(report.written, false)
  assert.equal(report.failed, 1)
  assert.match(report.providers[0].error, /could not persist the model list: configuration write refused/)
  assert.deepEqual(harness.events, [])
})

test('an unchanged catalog writes nothing and does not wake consumers', async () => {
  const harness = baseDeps({
    listConfigurableProviders: () => [directoryEntry('gateway')],
    describeConfig: () => configSnapshot({
      gateway: providerProfile({ models: [{ id: 'keep', name: 'Keep' }] }),
    }),
    fetchImpl: async () => jsonResponse({ data: [{ id: 'keep', name: 'Remote Keep' }] }),
  })
  const service = new ModelCatalogRefresh(harness.deps)
  const report = await service.refresh('manual')

  assert.equal(report.providers[0].status, 'unchanged')
  assert.equal(report.written, false)
  assert.deepEqual(harness.writes, [])
  assert.deepEqual(harness.events, [])
})

test('current providers are refreshed in parallel but one write groups them by namespace', async () => {
  const harness = baseDeps({
    listConfigurableProviders: () => [directoryEntry('a'), directoryEntry('b')],
    describeConfig: () => configSnapshot({
      a: providerProfile({ models: [{ id: 'a-old' }] }),
      b: providerProfile({ models: [{ id: 'b-old' }] }),
    }),
    fetchImpl: async (url) => {
      if (String(url).includes('/a/')) return jsonResponse({ data: [{ id: 'a-new' }] })
      return jsonResponse({ data: [{ id: 'b-new' }] })
    },
  })
  // Point each provider at its own URL path while sharing the namespace.
  harness.deps.listConfigurableProviders = () => [
    directoryEntry('a', { settingsPath: ['providers', 'a'] }),
    directoryEntry('b', { settingsPath: ['providers', 'b'] }),
  ]
  harness.deps.describeConfig = () => configSnapshot({
    a: providerProfile({ baseURL: 'https://gateway.example/a', models: [{ id: 'a-old' }] }),
    b: providerProfile({ baseURL: 'https://gateway.example/b', models: [{ id: 'b-old' }] }),
  })
  const service = new ModelCatalogRefresh(harness.deps)
  const report = await service.refresh('manual')

  assert.equal(report.providers.length, 2)
  assert.equal(harness.writes.length, 1)
  assert.equal(harness.writes[0].ns, NS)
  assert.equal(harness.writes[0].updates.length, 2)
  assert.deepEqual(harness.events, [['models', 'a'], ['models', 'b'], ['adapters']])
})

test('a rejected grouped write is retried per provider so one bad list does not discard the rest', async () => {
  const writes = []
  const harness = baseDeps({
    listConfigurableProviders: () => [directoryEntry('a'), directoryEntry('b')],
    describeConfig: () => configSnapshot({
      a: providerProfile({ models: [{ id: 'a-old' }] }),
      b: providerProfile({ models: [{ id: 'b-old' }] }),
    }),
    writeModels: async (ns, updates) => {
      writes.push(updates)
      if (updates.length > 1) throw new Error('one model in the group is invalid')
      if (updates[0].path[1] === 'b') throw new Error('b is invalid')
    },
    fetchImpl: async (url) => {
      if (String(url).includes('/a/')) return jsonResponse({ data: [{ id: 'a-new' }] })
      return jsonResponse({ data: [{ id: 'b-new' }] })
    },
  })
  harness.deps.describeConfig = () => configSnapshot({
    a: providerProfile({ baseURL: 'https://gateway.example/a', models: [{ id: 'a-old' }] }),
    b: providerProfile({ baseURL: 'https://gateway.example/b', models: [{ id: 'b-old' }] }),
  })
  const service = new ModelCatalogRefresh(harness.deps)
  const report = await service.refresh('manual')

  assert.equal(writes.length, 3)
  assert.equal(report.written, true)
  assert.equal(report.providers[0].status, 'updated')
  assert.equal(report.providers[1].status, 'failed')
  assert.match(report.providers[1].error, /b is invalid/)
  assert.deepEqual(harness.events, [['models', 'a'], ['adapters']])
})

test('one refresh at a time; a second caller joins the running run', async () => {
  let release
  let fetchCount = 0
  const harness = baseDeps({
    listConfigurableProviders: () => [directoryEntry('gateway')],
    describeConfig: () => configSnapshot({ gateway: providerProfile() }),
    fetchImpl: () => {
      fetchCount += 1
      return new Promise((resolve) => {
        release = () => resolve(jsonResponse({ data: [{ id: 'new' }] }))
      })
    },
  })
  const service = new ModelCatalogRefresh(harness.deps)
  const first = service.refresh('manual')
  const second = service.refresh('scheduled')
  await new Promise((resolve) => setTimeout(resolve, 5))

  assert.equal(service.isRefreshing(), true)
  assert.equal(fetchCount, 1)
  release()
  const [reportA, reportB] = await Promise.all([first, second])
  assert.equal(reportA.reason, 'manual')
  assert.equal(reportB.reason, 'manual')
  assert.equal(reportA.providers[0].status, 'updated')
  assert.equal(service.isRefreshing(), false)
})

test('a missing configuration editor is a run-wide error', async () => {
  const harness = baseDeps({
    describeConfig: () => { throw new Error('configuration unavailable') },
  })
  const service = new ModelCatalogRefresh(harness.deps)
  const report = await service.refresh('manual')

  assert.match(report.error, /configuration unavailable/)
  assert.equal(report.providers.length, 0)
})

test('providers without an explicit model list are not targets', async () => {
  const harness = baseDeps({
    listConfigurableProviders: () => [directoryEntry('catalog-route')],
    describeConfig: () => configSnapshot({
      'catalog-route': { apiKeyEnv: 'CATALOG_KEY' },
    }),
  })
  const service = new ModelCatalogRefresh(harness.deps)
  const report = await service.refresh('manual')

  assert.deepEqual(report.providers, [])
  assert.equal(report.failed, 0)
})
