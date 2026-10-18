import assert from 'node:assert/strict'
import { test } from 'node:test'
import { batchNote, childNote, childPrompt, singleNote, wakesParent } from '../dist/index.js'

const report = (status, summary) => ({ status, summary, at: '2026-10-18T09:00:00.000Z' })

test('a batch note lists each child, and what still runs', () => {
  const note = batchNote(
    [
      {
        id: 'c1',
        title: 'Bisect',
        teammate: 'Riley',
        report: report('report', 'canary.34\nbroke it'),
      },
      { id: 'c2', title: 'Upgrade', teammate: 'Sam', report: report('needs_person', 'Asked') },
    ],
    [{ id: 'c3', title: 'Slow', teammate: 'Riley' }],
  )
  assert.match(note, /^2 child threads you were waiting for have finished:/)
  assert.match(note, /- Riley · “Bisect” \(c1\): reports\. canary\.34 broke it/)
  assert.match(note, /- Sam · “Upgrade” \(c2\): needs a person/)
  assert.match(note, /Still working past the time you gave them/)
  assert.match(note, /- Riley · “Slow” \(c3\)/)
})

test('every note Brigade writes for a parent or a child is recognized, and nothing else', () => {
  const one = [{ id: 'c1', title: 'A', teammate: 'Riley', report: report('report', 'x') }]
  for (const note of [
    batchNote(one, []),
    batchNote([...one, ...one], []),
    batchNote([], [{ id: 'c3', title: 'Slow', teammate: 'Riley' }]),
    singleNote({
      id: 'c1',
      title: 'Run',
      teammate: 'Riley',
      schedule: 'Watch',
      report: report('report', 'x'),
    }),
    singleNote({
      id: 'c1',
      title: 'Late',
      teammate: 'Riley',
      schedule: null,
      report: report('failed', 'x'),
    }),
  ])
    assert.equal(childNote(note), 'report', note)
  assert.equal(
    childNote(childPrompt({ from: 'Riley', parentTitle: 'Live reload', instructions: 'Do it' })),
    'task',
  )
  assert.equal(childNote('Can you look at the child threads you were waiting for?'), null)
  assert.equal(childNote('Riley started this thread from the thread “x” and then'), null)
})

test('only a report or a failure wakes a parent that was not waiting', () => {
  assert.deepEqual(['nothing', 'report', 'needs_person', 'failed', 'cancelled'].map(wakesParent), [
    false,
    true,
    false,
    true,
    false,
  ])
})
