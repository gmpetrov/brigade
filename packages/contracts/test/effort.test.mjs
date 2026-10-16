import assert from 'node:assert/strict'
import { test } from 'node:test'
import { StartThread, UpdateThread } from '../dist/api.js'
import { effortLabel, EFFORTS } from '../dist/models.js'
import { Effort } from '../dist/runner.js'

test('every effort the harnesses take has a label, and none is Default', () => {
  assert.deepEqual(
    EFFORTS.map((e) => e.id),
    Effort.options,
  )
  assert.equal(effortLabel('xhigh'), 'Extra high')
  assert.equal(effortLabel(null), 'Default')
})

test('a thread changes its effort, or goes back to the default', () => {
  assert.deepEqual(UpdateThread.parse({ effort: 'max' }), { effort: 'max' })
  assert.deepEqual(UpdateThread.parse({ effort: null }), { effort: null })
  assert.deepEqual(UpdateThread.parse({}), {})
  assert.equal(UpdateThread.safeParse({ effort: 'ultra' }).success, false)
})

test('a new thread may start with an effort', () => {
  const base = { teammateId: 't', computerId: 'c', text: 'hi' }
  assert.equal(StartThread.parse({ ...base, effort: 'high' }).effort, 'high')
  assert.equal(StartThread.parse(base).effort, undefined)
})
