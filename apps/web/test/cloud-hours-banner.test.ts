import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hoursCard, hoursTone } from '../components/cloud-hours-banner'

// The sidebar's card for Starter's hours (components/cloud-hours-banner.tsx): nothing below 80%
// of the period's hours, how many are used from there, and that they are used up at 100%.
const resetsAt = '2026-12-03T10:00:00.000Z'

test('nothing below 80 hours of 100', () => {
  assert.equal(hoursCard({ used: 79.9, included: 100, resetsAt }), null)
})

test('from 80 hours, how many are used and when they start over', () => {
  const card = hoursCard({ used: 86.4, included: 100, resetsAt })!
  assert.equal(card.usedUp, false)
  assert.equal(card.title, '86 of 100 cloud hours')
  assert.match(card.line, /^Starts over on /)
  assert.ok(Math.abs(card.percent - 86.4) < 0.01)
})

test('at 100 hours, used up until they start over', () => {
  const card = hoursCard({ used: 103, included: 100, resetsAt })!
  assert.equal(card.usedUp, true)
  assert.equal(card.title, 'Cloud hours used up')
  assert.match(card.line, /^Back on .*waits until then\.$/)
  assert.equal(card.percent, 100)
})

test('the bar turns orange from 80 hours and red once used up', () => {
  assert.equal(hoursTone(50, 100), null)
  assert.equal(hoursTone(80, 100)?.fill, 'bg-warning')
  assert.equal(hoursTone(100, 100)?.fill, 'bg-destructive')
})
