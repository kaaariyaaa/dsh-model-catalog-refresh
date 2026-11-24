import assert from 'node:assert/strict'
import test from 'node:test'

import { getAtPath, setAtPath } from '../lib/raw-config.js'

test('getAtPath and setAtPath operate on own nested properties', () => {
  const root = { providers: { gateway: { models: [{ id: 'a' }] } } }
  assert.deepEqual(getAtPath(root, ['providers', 'gateway', 'models']), [{ id: 'a' }])
  setAtPath(root, ['providers', 'gateway', 'models'], [{ id: 'b' }])
  assert.deepEqual(root.providers.gateway.models, [{ id: 'b' }])
})

test('setAtPath refuses a missing provider instead of creating it', () => {
  const root = { providers: {} }
  assert.throws(() => setAtPath(root, ['providers', 'missing', 'models'], []), /not writable/)
})

test('prototype-shaped provider and header keys cannot pollute Object.prototype', () => {
  const root = JSON.parse('{"providers":{"__proto__":{"models":[{"id":"keep"}]}}}')
  assert.throws(
    () => setAtPath(root, ['providers', '__proto__', 'models'], [{ id: 'evil' }]),
    /not writable/,
  )
  assert.equal(Object.prototype.models, undefined)
  assert.equal(Object.prototype.evil, undefined)
  assert.equal(getAtPath(root, ['providers', '__proto__', 'models']), undefined)
})

test('a dynamic expression node is never traversed', () => {
  const root = { providers: { gateway: { __jsExpr: 'computeProfile()' } } }
  assert.throws(
    () => setAtPath(root, ['providers', 'gateway', 'models'], []),
    /not a writable object/,
  )
})

test('a dynamic models expression is not overwritten', () => {
  const root = { providers: { gateway: { models: { __jsExpr: 'loadModels()' } } } }
  assert.throws(
    () => setAtPath(root, ['providers', 'gateway', 'models'], []),
    /dynamic expression/,
  )
})
