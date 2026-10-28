import assert from 'node:assert/strict'
import { test } from 'node:test'
import { groupMarks, THREAD_TIMELINE_MARKS } from '@brigade/contracts'
import { timelineMarks } from '../lib/timeline-marks'

// 123 short exchanges: the member's messages at seq 1, 3, 5…
const all = Array.from({ length: 123 }, (_, i) => ({
  seq: 2 * i + 1,
  at: new Date(2026, 9, 1, 0, i).toISOString(),
  text: `Question ${i + 1}`,
}))
// The API's answer: the same grouping, done in its query.
const fetched = groupMarks(all)

test('jumped to the first page, the messages still in a gap keep their marks', () => {
  // Its first 30 and latest 30 are loaded; the 63 between are not.
  const loaded = [...all.slice(0, 30), ...all.slice(-30)]
  const marks = timelineMarks(loaded, fetched)
  assert.equal(marks.length, THREAD_TIMELINE_MARKS)
  assert.deepEqual(marks, fetched)
  assert.equal(
    marks.reduce((n, m) => n + m.count, 0),
    all.length,
  )
})

test('a message sent after the answer gets a mark of its own', () => {
  const sent = { seq: 400, at: new Date(2026, 9, 2).toISOString(), text: 'One more' }
  const marks = timelineMarks([...all.slice(-30), sent], fetched)
  assert.equal(marks.length, THREAD_TIMELINE_MARKS + 1)
  assert.deepEqual(marks.at(-1), { ...sent, count: 1, last: 400 })
})

test('without an answer, what is loaded is grouped', () => {
  assert.deepEqual(timelineMarks(all, undefined), fetched)
  assert.equal(timelineMarks(all.slice(0, 10), undefined).length, 10)
})
