import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  batchNote,
  childNote,
  childPrompt,
  asksParallel,
  forPeople,
  inParallel,
  mayChangeQueued,
  singleNote,
  wakesParent,
} from '../dist/index.js'

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

test('people read a note without what it tells the teammate to do next', () => {
  const one = [{ id: 'c1', title: 'A', teammate: 'Cody', report: report('report', 'All good') }]
  const batch = forPeople(batchNote(one, []))
  assert.equal(
    batch,
    'The child thread you were waiting for has finished:\n- Cody · “A” (c1): reports. All good',
  )
  const single = forPeople(
    singleNote({
      id: 'c1',
      title: 'Run',
      teammate: 'Cody',
      schedule: 'Watch',
      report: report('report', 'x'),
    }),
  )
  assert.doesNotMatch(single, /read_child/)
  assert.match(single, /\n\nx$/)
  const task = forPeople(childPrompt({ from: 'Riley', parentTitle: 'P', instructions: 'Do it' }))
  assert.match(task, /\n\nDo it$/)
  // The teammate still gets them, and a person's own words are left as they are.
  assert.match(batchNote(one, []), /`read_child`/)
  assert.equal(forPeople('Call `report` when done.'), 'Call `report` when done.')
})

test('a queued message nobody typed can be steered, not edited or cancelled', () => {
  for (const action of ['steer', 'edit', 'cancel'])
    assert.equal(mayChangeQueued('m1', action), true)
  assert.equal(mayChangeQueued(null, 'steer'), true)
  assert.equal(mayChangeQueued(null, 'edit'), false)
  assert.equal(mayChangeQueued(null, 'cancel'), false)
})

test('a message sent to run in parallel asks for a child, and people read it as typed', () => {
  const sent = inParallel('Propose six designs for the page\n')
  assert.ok(asksParallel(sent))
  assert.match(sent, /`start_child` now with `wait: false`/)
  assert.equal(forPeople(sent), 'Propose six designs for the page')
  // Sent twice, it asks once.
  assert.equal(inParallel(sent), sent)
  assert.equal(asksParallel('Propose six designs for the page'), false)
  assert.equal(childNote(sent), null)
  // Only a person's own message may go in parallel.
  assert.equal(mayChangeQueued('m1', 'parallel'), true)
  assert.equal(mayChangeQueued(null, 'parallel'), false)
})
