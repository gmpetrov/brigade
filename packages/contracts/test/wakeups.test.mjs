import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ScheduleOperation } from '../dist/schedules.js'
import { wakeTime } from '../dist/wakeups.js'

const now = new Date('2026-10-16T10:00:00Z')

test('a wake-up in minutes or at a time', () => {
  assert.deepEqual(wakeTime({ minutes: 10 }, now), new Date('2026-10-16T10:10:00Z'))
  assert.deepEqual(
    wakeTime({ at: '2026-10-16T14:30:00+02:00' }, now),
    new Date('2026-10-16T12:30:00Z'),
  )
})

test('refuses both, neither, a bad time, too soon and too late', () => {
  assert.match(wakeTime({ minutes: 5, at: '2026-10-16T12:00:00Z' }, now), /either minutes or at/)
  assert.match(wakeTime({}, now), /either minutes or at/)
  assert.match(wakeTime({ at: 'tomorrow' }, now), /not an ISO 8601 time/)
  assert.match(wakeTime({ minutes: 0.5 }, now), /at least 1 minute/)
  assert.match(wakeTime({ at: '2026-10-16T09:00:00Z' }, now), /at least 1 minute/)
  assert.match(wakeTime({ minutes: 8 * 24 * 60 }, now), /at most 7 days/)
  assert.ok(wakeTime({ minutes: 7 * 24 * 60 }, now) instanceof Date)
})

test('wake-up operations travel with the schedule tools', () => {
  assert.equal(
    ScheduleOperation.parse({ name: 'wake', minutes: 10, note: 'Check CI' }).name,
    'wake',
  )
  assert.equal(ScheduleOperation.parse({ name: 'list_wakeups' }).name, 'list_wakeups')
  assert.equal(
    ScheduleOperation.parse({ name: 'cancel_wakeup', wakeupId: 'w1' }).name,
    'cancel_wakeup',
  )
  assert.throws(() => ScheduleOperation.parse({ name: 'wake', minutes: 10, note: '  ' }))
})
