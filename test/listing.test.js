import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildListingUrl,
  parseModelListing,
  sanitizeUrl,
} from '../lib/listing.js'

test('OpenAI-style data array keeps chat models and drops non-chat entries', () => {
  const models = parseModelListing({
    object: 'list',
    data: [
      {
        id: 'deepseek-v4.1-flash',
        name: 'DeepSeek V4.1 Flash',
        context_length: 1000000,
        max_tokens: 384000,
        modalities: { input: ['text', 'image/png'], output: ['text'] },
      },
      { id: 'text-embedding-3-small', type: 'embedding', object: 'model' },
      { id: 'text-embedding-3-large', object: 'model' },
      { id: 'gpt-image-1', object: 'model' },
      { id: 'jev-1.14', type: 'decision', modalities: { output: ['decision'] } },
      { id: 'reranker-1', type: 'rerank' },
      { name: 'No id' },
      { id: '' },
    ],
  }, 'openai-completions')

  assert.deepEqual(models, [{
    id: 'deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash',
    contextWindow: 1000000,
    maxTokens: 384000,
    input: ['text', 'image'],
  }])
})

test('enriched models map uses the key as the request id and supports limits', () => {
  const models = parseModelListing({
    models: {
      'acme-large': {
        id: 'acme/canonical-large',
        display_name: 'Acme Large',
        limit: { context: 65536, output: 4096 },
        top_provider: { max_completion_tokens: 2048 },
      },
      'acme-embed': { type: 'embedding' },
    },
  }, 'openai-responses')

  assert.deepEqual(models, [{
    id: 'acme-large',
    name: 'Acme Large',
    contextWindow: 65536,
    maxTokens: 4096,
  }])
})

test('Gemini listing strips models/ and keeps generateContent models', () => {
  const models = parseModelListing({
    models: [
      {
        name: 'models/gemini-4-argon',
        displayName: 'Gemini 4 Argon',
        inputTokenLimit: 1048576,
        outputTokenLimit: 65536,
        supportedGenerationMethods: ['generateContent'],
      },
      {
        name: 'models/text-embedding-004',
        supportedGenerationMethods: ['embedContent'],
      },
    ],
  }, 'google-generative-ai')

  assert.deepEqual(models, [{
    id: 'gemini-4-argon',
    name: 'Gemini 4 Argon',
    contextWindow: 1048576,
    maxTokens: 65536,
  }])
})

test('Anthropic data array reads display_name', () => {
  const models = parseModelListing({
    data: [{ id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', type: 'model' }],
  }, 'anthropic-messages')

  assert.deepEqual(models, [{ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' }])
})

test('a top-level array is accepted', () => {
  assert.deepEqual(
    parseModelListing([{ id: 'm1', name: 'Model 1' }], 'openai-completions'),
    [{ id: 'm1', name: 'Model 1' }],
  )
})

test('a plain string array of ids is accepted', () => {
  assert.deepEqual(
    parseModelListing({ data: ['m1', 'm2'] }, 'openai-completions'),
    [{ id: 'm1' }, { id: 'm2' }],
  )
})

test('duplicate ids are deduplicated in endpoint order', () => {
  const models = parseModelListing({
    data: [{ id: 'm1', name: 'First' }, { id: 'm1', name: 'Second' }],
  }, 'openai-completions')
  assert.deepEqual(models, [{ id: 'm1', name: 'First' }])
})

test('an empty listing is an error, never a delete signal', () => {
  assert.throws(
    () => parseModelListing({ object: 'list', data: [] }, 'openai-completions'),
    (error) => error.code === 'EMPTY_LISTING',
  )
  assert.throws(
    () => parseModelListing({ data: [{ id: 'x', type: 'embedding' }] }, 'openai-completions'),
    (error) => error.code === 'EMPTY_LISTING',
  )
})

test('an unrecognized listing shape is an error', () => {
  assert.throws(
    () => parseModelListing({ object: 'list' }, 'openai-completions'),
    (error) => error.code === 'INVALID_RESPONSE',
  )
  assert.throws(
    () => parseModelListing('nope', 'openai-completions'),
    (error) => error.code === 'INVALID_RESPONSE',
  )
})

test('listing URLs follow each protocol and preserve gateway paths', () => {
  assert.equal(
    buildListingUrl('https://opencode.ai/inference/go/openai/v1', 'openai-completions').href,
    'https://opencode.ai/inference/go/openai/v1/models',
  )
  assert.equal(
    buildListingUrl('https://api.anthropic.com/v1/', 'anthropic-messages').href,
    'https://api.anthropic.com/v1/models?limit=1000',
  )
  assert.equal(
    buildListingUrl('https://generativelanguage.googleapis.com/v1beta', 'google-generative-ai').href,
    'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
  )
  assert.equal(
    buildListingUrl('https://gateway.example/openai/v1?api-version=2026-01-01', 'openai-responses').href,
    'https://gateway.example/openai/v1/models?api-version=2026-01-01',
  )
})

test('invalid base URLs are refused', () => {
  assert.throws(
    () => buildListingUrl('not a URL', 'openai-completions'),
    (error) => error.code === 'INVALID_CONFIG',
  )
  assert.throws(
    () => buildListingUrl('file:///tmp/models', 'openai-completions'),
    (error) => error.code === 'INVALID_CONFIG',
  )
})

test('sanitizeUrl removes query credentials and userinfo', () => {
  assert.equal(
    sanitizeUrl('https://user:pass@example.test/v1/models?key=secret'),
    'https://example.test',
  )
  assert.equal(sanitizeUrl('not a URL'), '<invalid URL>')
})


test('unsafe, oversized, or control-bearing ids and names are not persisted', () => {
  const models = parseModelListing({
    data: [
      { id: '__proto__' },
      { id: 'constructor' },
      { id: 'x'.repeat(300) },
      { id: 'bad\nid' },
      { id: 'ok', name: 'bad\nname' },
      { id: 'too-long-name', name: 'n'.repeat(300) },
      { id: 'good', name: 'Good Model', context_length: 1000 },
    ],
  }, 'openai-completions')
  assert.deepEqual(models, [
    { id: 'ok' },
    { id: 'too-long-name' },
    { id: 'good', name: 'Good Model', contextWindow: 1000 },
  ])
})
