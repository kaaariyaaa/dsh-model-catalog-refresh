import assert from 'node:assert/strict'
import test from 'node:test'

import { REFRESH_INTERVAL_MS } from '../lib/index.js'
import { createRefreshScheduler } from '../lib/scheduler.js'

function fakeTimers() {
  const created = { timeouts: [], intervals: [], clearedTimeouts: [], clearedIntervals: [] }
  const handle = (kind, callback) => ({
    kind,
    callback,
    unrefCalled: 0,
    unref() { this.unrefCalled += 1 },
  })
  return {
    created,
    timers: {
      setTimeout: (callback) => {
        const timer = handle('timeout', callback)
        created.timeouts.push(timer)
        return timer
      },
      setInterval: (callback) => {
        const timer = handle('interval', callback)
        created.intervals.push(timer)
        return timer
      },
      clearTimeout: (timer) => { created.clearedTimeouts.push(timer) },
      clearInterval: (timer) => { created.clearedIntervals.push(timer) },
    },
  }
}

test('the schedule is exactly four hours', () => {
  assert.equal(REFRESH_INTERVAL_MS, 4 * 60 * 60 * 1000)
})

test('start schedules one zero-delay run and one four-hour interval', () => {
  const fake = fakeTimers()
  let startup = 0
  let periodic = 0
  const scheduler = createRefreshScheduler(
    () => { startup += 1 },
    () => { periodic += 1 },
    REFRESH_INTERVAL_MS,
    fake.timers,
  )
  scheduler.start()
  scheduler.start()

  assert.equal(fake.created.timeouts.length, 1)
  assert.equal(fake.created.intervals.length, 1)
  assert.equal(fake.created.timeouts[0].unrefCalled, 1)
  assert.equal(fake.created.intervals[0].unrefCalled, 1)
  assert.equal(startup, 0, 'the first refresh waits for the next turn')
  fake.created.timeouts[0].callback()
  fake.created.intervals[0].callback()
  assert.equal(startup, 1)
  assert.equal(periodic, 1)
})

test('stop clears both timers and later starts are ignored', () => {
  const fake = fakeTimers()
  const scheduler = createRefreshScheduler(() => {}, () => {}, 1000, fake.timers)
  scheduler.start()
  scheduler.stop()

  assert.equal(fake.created.clearedTimeouts.length, 1)
  assert.equal(fake.created.clearedIntervals.length, 1)
  scheduler.start()
  assert.equal(fake.created.timeouts.length, 1)
  assert.equal(fake.created.intervals.length, 1)
})
