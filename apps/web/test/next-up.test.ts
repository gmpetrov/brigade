import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NEXT_FRESH_MS, nextShownUntil } from '../lib/next-up'

test('while a turn runs, who answers next shows for as long as it runs', () => {
  assert.equal(nextShownUntil(true, undefined), Infinity)
  assert.equal(nextShownUntil(true, 1_000), Infinity)
})

test('between turns, it shows for a while after the last one ended, then no longer', () => {
  const until = nextShownUntil(false, 1_000)!
  assert.equal(until, 1_000 + NEXT_FRESH_MS)
  assert.ok(1_000 + NEXT_FRESH_MS - 1 < until, 'just before: still shown')
  assert.ok(!(1_000 + NEXT_FRESH_MS < until), 'once past it: gone')
})

test('with no turn ended yet and none running, it does not show', () => {
  assert.equal(nextShownUntil(false, undefined), undefined)
})
