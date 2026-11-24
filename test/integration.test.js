import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('..', import.meta.url))
const skip = process.env.DSH_INTEGRATION !== '1'
const dshBin = process.env.DSH_BIN ?? 'dsh'

/** Start a fake provider listing endpoint. */
async function startProvider(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    port: address.port,
    async close() {
      await new Promise(resolve => server.close(resolve))
    },
  }
}

/** Create a throwaway DSH home with a custom ACP profile containing this checkout. */
async function makeHome(patch) {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-model-refresh-'))
  const profile = path.join(home, 'profiles', 'testacp')
  await fs.mkdir(path.join(profile, 'node_modules'), { recursive: true })
  await fs.writeFile(path.join(profile, 'cordis.yml'), '[]\n')
  await fs.writeFile(path.join(profile, 'cordis.patch.yml'), patch)
  await fs.writeFile(path.join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-testacp',
    private: true,
    dependencies: { 'dsh-model-catalog-refresh': `link:${repo}` },
    dsh: {
      profile: {
        bundles: [
          '@deepseek-ai/dsh-base',
          '@deepseek-ai/dsh-acp-app',
          'dsh-model-catalog-refresh',
        ],
      },
    },
  }, null, 2))
  await fs.symlink(repo, path.join(profile, 'node_modules', 'dsh-model-catalog-refresh'), 'dir')
  return { home, profile }
}

/** Run one CLI refresh with a captured stream and a hard deadline. */
async function runRefresh(home, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(dshBin, ['testacp', 'model-refresh'], {
      cwd: repo,
      env: { ...process.env, DSH_HOME: home, ...env },
      // Keep stdin open: a CLI refresh must exit on its own, not because EOF
      // happened to release an ACP bridge that should never have mounted.
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`dsh model-refresh timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, 60_000)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

/** Read a profile patch. */
async function readPatch(profile) {
  return fs.readFile(path.join(profile, 'cordis.patch.yml'), 'utf8')
}

test('ACP help still exits cleanly and advertises model-refresh', { skip }, async (t) => {
  const { home } = await makeHome('[]\n')
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const result = await new Promise((resolve, reject) => {
    const child = spawn(dshBin, ['testacp', '--help'], {
      cwd: repo,
      env: { ...process.env, DSH_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.once('error', reject)
    child.once('exit', code => resolve({ code, stdout, stderr }))
  })
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /model-refresh/)
  assert.doesNotMatch(result.stderr, /startup failed/)
})

test('ACP still serves when the automatic refresh service is unavailable', { skip }, async (t) => {
  const { home } = await makeHome(`- id: model-catalog-refresh
  disabled: true
`)
  t.after(() => fs.rm(home, { recursive: true, force: true }))

  const child = spawn(dshBin, ['testacp'], {
    cwd: repo,
    env: { ...process.env, DSH_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  t.after(() => { child.kill('SIGKILL') })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk.toString() })

  const pending = new Map()
  const lines = readline.createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    let message
    try { message = JSON.parse(line) } catch { return }
    const waiter = pending.get(message.id)
    if (waiter === undefined) return
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)))
    else waiter.resolve(message.result)
  })
  const request = (method, params, timeoutMs = 20_000) => new Promise((resolve, reject) => {
    const id = 1
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`timed out waiting for ${method}\nstderr:\n${stderr}`))
    }, timeoutMs)
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value) },
      reject: (error) => { clearTimeout(timer); reject(error) },
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })

  const init = await request('initialize', { protocolVersion: 1, clientCapabilities: {} })
  assert.equal(init.agentInfo.name, 'deepseek-harness-acp')
  child.stdin.end()
})

test('CLI adds, removes, and preserves entries, then is idempotent', { skip }, async (t) => {
  const provider = await startProvider((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      object: 'list',
      data: [
        { id: 'keep', name: 'Remote Keep', context_length: 999 },
        { id: 'new-a', name: 'New A', context_length: 65536, top_provider: { max_completion_tokens: 4096 } },
        { id: 'text-embedding-3-small', type: 'embedding' },
      ],
    }))
  })
  t.after(() => provider.close())

  const { home, profile } = await makeHome(`- id: llm-pi-ai
  config:
    providers:
      fake:
        api: openai-completions
        baseURL: http://127.0.0.1:${String(provider.port)}/openai/v1
        apiKeyEnv: TEST_KEY
        models:
          - id: keep
            name: Keep Me
            contextWindow: 111
          - id: old
            name: Old
`)
  t.after(() => fs.rm(home, { recursive: true, force: true }))

  const first = await runRefresh(home, { TEST_KEY: 'integration-key' })
  assert.equal(first.code, 0, first.stderr)
  assert.match(first.stdout, /fake: updated/)
  const updated = await readPatch(profile)
  assert.match(updated, /id: new-a/)
  assert.doesNotMatch(updated, /id: old\n/)
  assert.match(updated, /name: Keep Me/)
  assert.match(updated, /contextWindow: 111/)
  assert.doesNotMatch(updated, /input: \[\]/, 'schema defaults must not be materialized')
  assert.doesNotMatch(updated, /integration-key/, 'credentials must never be persisted or printed')

  const mtime = (await fs.stat(path.join(profile, 'cordis.patch.yml'))).mtimeMs
  await new Promise(resolve => setTimeout(resolve, 20))
  const second = await runRefresh(home, { TEST_KEY: 'integration-key' })
  assert.equal(second.code, 0, second.stderr)
  assert.match(second.stdout, /fake: unchanged/)
  const after = await readPatch(profile)
  assert.equal(after, updated)
  assert.equal((await fs.stat(path.join(profile, 'cordis.patch.yml'))).mtimeMs, mtime)
})

test('automatic startup refresh reaches a live ACP session and the next session', { skip }, async (t) => {
  let releaseModels
  const gate = new Promise((resolve) => { releaseModels = resolve })
  const provider = await startProvider(async (req, res) => {
    if (req.url.startsWith('/release')) {
      releaseModels()
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
      return
    }
    await gate
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      data: [
        { id: 'keep', name: 'Keep Me' },
        { id: 'new-a', name: 'New A', context_length: 65536 },
      ],
    }))
  })
  t.after(() => provider.close())

  const { home, profile } = await makeHome(`- id: llm-pi-ai
  config:
    providers:
      fake:
        api: openai-completions
        baseURL: http://127.0.0.1:${String(provider.port)}/openai/v1
        apiKeyEnv: TEST_KEY
        models:
          - id: keep
            name: Keep Me

- id: acp
  config:
    provider: fake
    model: keep
`)
  const cwd = await mkdtemp(path.join(tmpdir(), 'dsh-model-refresh-acp-'))
  t.after(async () => {
    await fs.rm(home, { recursive: true, force: true })
    await fs.rm(cwd, { recursive: true, force: true })
  })

  const child = spawn(dshBin, ['testacp'], {
    cwd: repo,
    env: { ...process.env, DSH_HOME: home, TEST_KEY: 'integration-key' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  t.after(() => { child.kill('SIGKILL') })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk.toString() })

  const notifications = []
  const pending = new Map()
  let nextId = 1
  const lines = readline.createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    let message
    try { message = JSON.parse(line) } catch { return }
    if (message.method === 'session/update') notifications.push(message.params)
    const waiter = pending.get(message.id)
    if (waiter === undefined) return
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)))
    else waiter.resolve(message.result)
  })

  const request = (method, params, timeoutMs = 20_000) => new Promise((resolve, reject) => {
    const id = nextId++
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`timed out waiting for ${method}\nstderr:\n${stderr}`))
    }, timeoutMs)
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value) },
      reject: (error) => { clearTimeout(timer); reject(error) },
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })

  const modelNames = (configOptions) => {
    const modelOption = configOptions?.find(option => option.id === 'model')
    return (modelOption?.options ?? []).flatMap(group => group.options.map(option => `${group.group}/${option.name}`))
  }

  await request('initialize', { protocolVersion: 1, clientCapabilities: {} })
  const first = await request('session/new', { cwd, mcpServers: [] })
  assert.ok(modelNames(first.configOptions).includes('fake/Keep Me'))
  assert.ok(!modelNames(first.configOptions).includes('fake/New A'), 'refresh must still be waiting on the provider gate')

  // Release the provider now that a session exists; the plugin must update the
  // stored catalog and push config_option_update to the live session.
  const release = await fetch(`http://127.0.0.1:${String(provider.port)}/release`)
  assert.equal(release.status, 200)

  const deadline = Date.now() + 20_000
  while (!(await readPatch(profile)).includes('new-a')) {
    if (Date.now() > deadline) throw new Error(`startup refresh did not persist\n${stderr}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  let liveNames
  while (Date.now() < deadline) {
    for (const notification of notifications) {
      if (notification.update?.sessionUpdate !== 'config_option_update') continue
      const names = modelNames(notification.update.configOptions)
      if (names.includes('fake/New A')) liveNames = names
    }
    if (liveNames !== undefined) break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.ok(liveNames !== undefined, `expected a live config_option_update with New A\n${stderr}`)
  assert.ok(liveNames.includes('fake/Keep Me'))

  const second = await request('session/new', { cwd, mcpServers: [] })
  assert.ok(modelNames(second.configOptions).includes('fake/New A'))
  await request('session/close', { sessionId: first.sessionId }).catch(() => {})
  await request('session/close', { sessionId: second.sessionId }).catch(() => {})
  child.stdin.end()
})

test('CLI isolates failures and keeps lists on HTTP errors and empty replies', { skip }, async (t) => {
  const provider = await startProvider((req, res) => {
    if (req.url.startsWith('/fail/')) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end('{"error":"boom"}')
      return
    }
    if (req.url.startsWith('/empty/')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"object":"list","data":[]}')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"data":[{"id":"keep"},{"id":"new-a"}]}')
  })
  t.after(() => provider.close())

  const { home, profile } = await makeHome(`- id: llm-pi-ai
  config:
    providers:
      broken:
        api: openai-completions
        baseURL: http://127.0.0.1:${String(provider.port)}/fail/v1
        apiKeyEnv: TEST_KEY
        models:
          - id: broken-keep
      empty:
        api: openai-completions
        baseURL: http://127.0.0.1:${String(provider.port)}/empty/v1
        apiKeyEnv: TEST_KEY
        models:
          - id: empty-keep
      working:
        api: openai-completions
        baseURL: http://127.0.0.1:${String(provider.port)}/openai/v1
        apiKeyEnv: TEST_KEY
        models:
          - id: keep
`)
  t.after(() => fs.rm(home, { recursive: true, force: true }))

  const result = await runRefresh(home, { TEST_KEY: 'integration-key' })
  assert.equal(result.code, 1)
  assert.match(result.stdout, /broken: FAILED/)
  assert.match(result.stdout, /empty: FAILED/)
  assert.match(result.stdout, /working: updated/)
  const patch = await readPatch(profile)
  assert.match(patch, /id: broken-keep/)
  assert.match(patch, /id: empty-keep/)
  assert.match(patch, /id: new-a/)
})
