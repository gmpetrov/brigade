import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  fromTaskBrief,
  fromTaskComment,
  scheduledRunMessage,
  scheduledRunNote,
  taskBrief,
  taskComment,
  wakeupMessage,
  wakeupNote,
} from '../dist/index.js'

test('a wake-up message reads back, late or not', () => {
  // As the API wrote it before wakeupMessage: threads already hold these.
  const old =
    'Wake-up you set at 22 Oct 2026, 02:27 (Europe/Paris): Check the build.\nThen the release.\n\n' +
    'Check it now and tell the person what you found. Set another wake-up only if it is still not ready.'
  assert.deepEqual(wakeupNote(old), {
    set: '22 Oct 2026, 02:27',
    timezone: 'Europe/Paris',
    note: 'Check the build.\nThen the release.',
  })
  const late = {
    set: '22 Oct 2026, 02:27',
    timezone: 'UTC',
    lateMinutes: 12,
    note: 'CI (#12): done?',
  }
  assert.deepEqual(wakeupNote(wakeupMessage(late)), late)
})

test('a person’s text is not a wake-up', () => {
  assert.equal(wakeupNote('Wake-up you set at noon (UTC): check it'), null)
  assert.equal(wakeupNote('hello'), null)
})

test('a scheduled run message reads back, with or without a parent', () => {
  const run = {
    title: 'Weekly "digest"',
    due: '20 Oct 2026, 09:00',
    timezone: 'Europe/Paris',
    instructions: 'Sum up.\n\nPost it.',
  }
  assert.deepEqual(scheduledRunNote(scheduledRunMessage(run)), {
    title: run.title,
    due: run.due,
    timezone: run.timezone,
    instructions: run.instructions,
  })
  assert.equal(
    scheduledRunNote(scheduledRunMessage({ ...run, parentTitle: 'Ops' }))?.instructions,
    run.instructions,
  )
  assert.equal(scheduledRunNote('Scheduled run of "x". Check it.'), null)
})

test('a task comment reads back', () => {
  const c = { from: 'Ada', threadTitle: 'Deploy', text: 'Done.' }
  assert.deepEqual(fromTaskComment(taskComment(c)), c)
  assert.equal(fromTaskComment('**Ada** said hi'), null)
})

test('a task brief a teammate wrote reads back', () => {
  const b = { from: 'Riley', threadTitle: 'Ops', title: 'Fix it', description: 'Then ship.' }
  assert.deepEqual(fromTaskBrief(taskBrief(b)), {
    from: 'Riley',
    threadTitle: 'Ops',
    text: '**Fix it**\n\nThen ship.',
  })
  assert.equal(fromTaskBrief('**Fix it**\n\nThen ship.'), null)
})
