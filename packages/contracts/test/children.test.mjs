import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  batchNote,
  childNote,
  childPrompt,
  asksParallel,
  followNote,
  forPeople,
  fromParent,
  inParallel,
  mayChangeQueued,
  noteThreads,
  parentMessage,
  REPORT_FILES_MAX,
  REPORT_MAX,
  REPORT_START,
  ScheduleOperation,
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

test('a report carries the whole of what its parent needs, and up to ten files', () => {
  const op = (summary, files) => ({
    name: 'report',
    status: 'report',
    summary,
    ...(files ? { files } : {}),
  })
  // A review of eleven findings, its reproductions inline: far past the few lines it once took.
  assert.ok(ScheduleOperation.safeParse(op('x'.repeat(9_000))).success)
  assert.ok(ScheduleOperation.safeParse(op('x'.repeat(REPORT_MAX))).success)
  assert.ok(!ScheduleOperation.safeParse(op('x'.repeat(REPORT_MAX + 1))).success)
  const ids = Array.from({ length: REPORT_FILES_MAX }, (_, i) => `att${i}`)
  assert.ok(ScheduleOperation.safeParse(op('x', ids)).success)
  assert.ok(!ScheduleOperation.safeParse(op('x', [...ids, 'one-more'])).success)
})

test("a note gives a report's start, and where the files it sent are", () => {
  const long = { ...report('report', `Found 11 problems.\n\n${'detail '.repeat(1_000)}`) }
  const files = ['attachments/bridge-repro.mjs', 'attachments/runner-repro.mts']
  const single = singleNote({
    id: 'c1',
    title: 'Review',
    teammate: 'Cody',
    schedule: null,
    report: { ...long, files },
  })
  const [card] = noteThreads(single).threads
  assert.ok(card.summary.startsWith('Found 11 problems.'))
  // Its start, cut where the note stops; read_child gives it whole.
  assert.ok(card.summary.length < REPORT_START + 200)
  assert.match(
    card.summary,
    /…\n\nFiles it sent \(in your working folder\): `attachments\/bridge-repro\.mjs`, `attachments\/runner-repro\.mts`\.$/,
  )
  const batch = batchNote(
    [
      {
        id: 'c1',
        title: 'Review',
        teammate: 'Cody',
        report: { ...report('report', 'Two problems.'), files },
      },
    ],
    [],
  )
  assert.match(
    batch,
    /- Cody · “Review” \(c1\): reports\. Two problems\. Files it sent \(in your working folder\): `attachments\/bridge-repro\.mjs`, `attachments\/runner-repro\.mts`\./,
  )
  assert.equal(
    noteThreads(batch).threads[0].summary,
    'Two problems. Files it sent (in your working folder): `attachments/bridge-repro.mjs`, `attachments/runner-repro.mts`.',
  )
  // Without files, as before.
  assert.doesNotMatch(
    batchNote([{ id: 'c1', title: 'A', teammate: 'Cody', report: report('report', 'x') }], []),
    /Files/,
  )
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
  // A child's first message from before its hint changed reads the same.
  const before =
    'Riley started this thread from the thread “P” and waits for your report.\n\nDo it\n\n' +
    'When you are done, call `report` once with what you found, then end your turn.'
  assert.equal(
    forPeople(before),
    forPeople(childPrompt({ from: 'Riley', parentTitle: 'P', instructions: 'Do it' })),
  )
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

test('people see each thread a report note tells about, to open it', () => {
  const batch = batchNote(
    [
      {
        id: 'c1',
        title: 'Review PR #51 (AI SDK 7)',
        teammate: 'Cody',
        report: report('failed', 'HTTP 403 (no access).'),
      },
      { id: 'c2', title: 'Upgrade', teammate: 'Sam', report: report('needs_person', 'Asked') },
    ],
    [{ id: 'c3', title: 'Slow', teammate: 'Riley' }],
  )
  assert.deepEqual(noteThreads(batch), {
    head: '2 child threads you were waiting for have finished:',
    threads: [
      {
        id: 'c1',
        title: 'Review PR #51 (AI SDK 7)',
        teammate: 'Cody',
        status: 'failed',
        summary: 'HTTP 403 (no access).',
      },
      { id: 'c2', title: 'Upgrade', teammate: 'Sam', status: 'needs_person', summary: 'Asked' },
      { id: 'c3', title: 'Slow', teammate: 'Riley', status: null, summary: '' },
    ],
  })
  const run = singleNote({
    id: 'c4',
    title: 'Run',
    teammate: 'Riley',
    schedule: 'Watch',
    report: report('report', 'line one\nline two'),
  })
  assert.deepEqual(noteThreads(run), {
    head: 'A run of the schedule “Watch”',
    threads: [
      { id: 'c4', title: 'Run', teammate: '', status: 'report', summary: 'line one\nline two' },
    ],
  })
  const late = singleNote({
    id: 'c5',
    title: 'Late',
    teammate: 'Riley',
    schedule: null,
    report: report('failed', 'x'),
  })
  assert.equal(noteThreads(late)?.threads[0]?.id, 'c5')
  assert.equal(noteThreads(late)?.threads[0]?.teammate, 'Riley')
  assert.doesNotMatch(late, /stopped waiting/)
  const lateRead = singleNote({
    id: 'c7',
    title: 'Late',
    teammate: 'Riley',
    schedule: null,
    report: report('report', 'x'),
    late: true,
  })
  assert.match(lateRead, /reports after you stopped waiting for it:/)
  assert.equal(noteThreads(lateRead)?.head, 'Finished after the wait for it ran out')
  // After a person talked it through in the child: the parent does not ask them again; people
  // read only what it said.
  const talked = singleNote({
    id: 'c8',
    title: 'Designs',
    teammate: 'Riley',
    schedule: null,
    report: { ...report('report', 'They picked 3.'), afterPerson: true },
  })
  assert.match(talked, /do not ask them the same again/)
  assert.deepEqual(noteThreads(talked), {
    head: null,
    threads: [
      {
        id: 'c8',
        title: 'Designs',
        teammate: 'Riley',
        status: 'report',
        summary: 'They picked 3.',
      },
    ],
  })
  const follow = followNote({
    id: 'c6',
    title: 'Fix',
    teammate: 'Sam',
    report: report('report', 'Done'),
  })
  assert.deepEqual(noteThreads(follow), {
    head: null,
    threads: [{ id: 'c6', title: 'Fix', teammate: 'Sam', status: 'report', summary: 'Done' }],
  })
  assert.equal(
    noteThreads('The child thread you were waiting for has finished:\nsomething else'),
    null,
  )
  assert.equal(noteThreads('Hello'), null)
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

test('what a parent tells its child later is read back as its note', () => {
  const sent = parentMessage({ from: 'Riley', parentTitle: 'Playbooks', text: 'Fetch **again**' })
  assert.equal(childNote(sent), 'parent')
  assert.deepEqual(fromParent(sent), {
    from: 'Riley',
    parentTitle: 'Playbooks',
    text: 'Fetch **again**',
  })
  // A person writing the same words is still a person.
  assert.equal(fromParent('**Riley** wrote from the parent thread'), null)
})
