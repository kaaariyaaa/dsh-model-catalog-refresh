import assert from 'node:assert/strict'
import test from 'node:test'

import { mergeModelLists } from '../lib/merge.js'

test('existing entries are preserved byte-for-byte, in order', () => {
  const existing = [
    { id: 'keep', name: 'Custom name', contextWindow: 123, input: ['text'], reasoningEfforts: { low: 'lo' } },
    { id: 'retired', name: 'Retired' },
  ]
  const result = mergeModelLists(existing, [
    { id: 'keep', name: 'Remote name', contextWindow: 999 },
    { id: 'new', name: 'New model', contextWindow: 65536, maxTokens: 4096, input: ['text', 'image'] },
  ])

  assert.deepEqual(result.models, [
    { id: 'keep', name: 'Custom name', contextWindow: 123, input: ['text'], reasoningEfforts: { low: 'lo' } },
    { id: 'new', name: 'New model', contextWindow: 65536, maxTokens: 4096, input: ['text', 'image'] },
  ])
  assert.deepEqual(result.added, ['new'])
  assert.deepEqual(result.removed, ['retired'])
})

test('a model whose remote label equals its id omits a redundant name', () => {
  const result = mergeModelLists([], [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }])
  assert.deepEqual(result.models, [{ id: 'deepseek-v4.1-flash' }])
})

test('an unchanged discovery produces no additions or removals', () => {
  const existing = [{ id: 'a', name: 'A' }, { id: 'b' }]
  const result = mergeModelLists(existing, [{ id: 'b' }, { id: 'a', name: 'Remote A' }])
  assert.deepEqual(result.added, [])
  assert.deepEqual(result.removed, [])
  assert.deepEqual(result.models, existing)
})

test('an empty discovery is refused before anything is deleted', () => {
  assert.throws(
    () => mergeModelLists([{ id: 'a' }], []),
    (error) => error.code === 'EMPTY_LISTING',
  )
})

test('malformed stored entries are refused rather than dropped', () => {
  assert.throws(
    () => mergeModelLists([{ name: 'missing id' }], [{ id: 'a' }]),
    (error) => error.code === 'INVALID_EXISTING_MODELS',
  )
  assert.throws(
    () => mergeModelLists([{ id: 'a' }, { id: 'a' }], [{ id: 'a' }]),
    (error) => error.code === 'INVALID_EXISTING_MODELS',
  )
})

test('the stored input array is not mutated', () => {
  const existing = [{ id: 'a', name: 'A' }]
  const snapshot = structuredClone(existing)
  mergeModelLists(existing, [{ id: 'b' }])
  assert.deepEqual(existing, snapshot)
})


test('unsafe stored ids are refused', () => {
  assert.throws(
    () => mergeModelLists([{ id: '__proto__' }], [{ id: 'a' }]),
    (error) => error.code === 'INVALID_EXISTING_MODELS',
  )
  assert.throws(
    () => mergeModelLists([{ id: 'x'.repeat(300) }], [{ id: 'a' }]),
    (error) => error.code === 'INVALID_EXISTING_MODELS',
  )
})
