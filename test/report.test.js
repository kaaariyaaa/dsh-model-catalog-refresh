import assert from 'node:assert/strict'
import test from 'node:test'

import { formatReport, logReport } from '../lib/report.js'

function maliciousReport() {
  return {
    reason: 'manual',
    startedAt: new Date(0).toISOString(),
    durationMs: 1,
    written: false,
    failed: 1,
    providers: [{
      provider: 'evil\nforged',
      displayName: 'Evil',
      status: 'failed',
      added: [],
      removed: [],
      total: 0,
      error: 'bad\nline\u001b[31mred',
    }],
  }
}

test('report output cannot forge lines or emit terminal controls', () => {
  const text = formatReport(maliciousReport())
  assert.doesNotMatch(text, /\nforged/)
  assert.doesNotMatch(text, /\u001b/)
  assert.match(text, /evil forged/)
  assert.match(text, /bad line/)
  assert.match(text, /\[31mred/)
})

test('log output applies the same sanitization', () => {
  const lines = []
  logReport(maliciousReport(), {
    info: line => lines.push(line),
    warn: line => lines.push(line),
    error: line => lines.push(line),
  })
  const text = lines.join('\n')
  assert.doesNotMatch(text, /\nforged/)
  assert.doesNotMatch(text, /\u001b/)
})
