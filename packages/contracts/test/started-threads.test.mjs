import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  childNote,
  childPrompt,
  fromStartedThreadBrief,
  fromTaskBrief,
  fromThreadComment,
  ScheduleOperation,
  startedThreadBrief,
  TaskOperation,
  threadComment,
} from '../dist/index.js'

test('start_thread needs a title and a brief; its lines come with their list', () => {
  const op = ScheduleOperation.parse({
    name: 'start_thread',
    title: 'Fix the export',
    brief: 'Exports fail with a 500. Done when one succeeds.',
    teammate: 'Cody',
    project: null,
    list: 'Projects/Acme/backlog.md',
    items: ['li_1', 'Fix the export'],
  })
  assert.equal(op.teammate, 'Cody')
  assert.equal(op.project, null)
  assert.deepEqual(op.items, ['li_1', 'Fix the export'])
  assert.equal(ScheduleOperation.safeParse({ name: 'start_thread', title: 'x' }).success, false)
  assert.equal(
    ScheduleOperation.safeParse({ name: 'start_thread', title: 'x', brief: '  ' }).success,
    false,
  )
})

test('message_thread names the thread it writes in', () => {
  const op = ScheduleOperation.parse({ name: 'message_thread', threadId: 't1', text: 'Also X' })
  assert.equal(op.threadId, 't1')
  assert.equal(ScheduleOperation.safeParse({ name: 'message_thread', text: 'x' }).success, false)
})

test('a started thread’s brief reads back, and is never taken for a child’s', () => {
  const text = startedThreadBrief({
    from: 'Riley',
    threadTitle: 'Plan the launch',
    title: 'Write the docs',
    brief: 'All of them.',
  })
  assert.deepEqual(fromStartedThreadBrief(text), {
    from: 'Riley',
    threadTitle: 'Plan the launch',
    text: '**Write the docs**\n\nAll of them.',
  })
  assert.equal(childNote(text), null)
  assert.equal(
    fromStartedThreadBrief(
      childPrompt({ from: 'Riley', parentTitle: 'Plan', instructions: 'Read it' }),
    ),
    null,
  )
})

test('a message from another thread reads back', () => {
  const text = threadComment({ from: 'Chief', threadTitle: 'Launch', text: 'Add the FAQ too' })
  assert.deepEqual(fromThreadComment(text), {
    from: 'Chief',
    threadTitle: 'Launch',
    text: 'Add the FAQ too',
  })
})

test('an old task thread’s brief still reads back', () => {
  const text = '**Riley** started this task from the thread “Plan”:\n\n**Docs**\n\nAll of them.'
  assert.deepEqual(fromTaskBrief(text), {
    from: 'Riley',
    threadTitle: 'Plan',
    text: '**Docs**\n\nAll of them.',
  })
})

test('the task tools of older runners still parse, for the API to answer them', () => {
  const create = TaskOperation.parse({ name: 'create', title: 'Fix', project: 'proj-1' })
  assert.equal(create.assignee, 'self')
  assert.equal(create.project, 'proj-1')
  assert.equal(TaskOperation.parse({ name: 'create', title: 'Fix', project: null }).project, null)
  const update = TaskOperation.parse({ name: 'update', taskId: 't1', project: null })
  assert.equal(update.project, null)
  assert.equal(TaskOperation.safeParse({ name: 'update', taskId: 't1', project: 3 }).success, false)
})

test('a playbook files an idea in a line', () => {
  const op = ScheduleOperation.parse({ name: 'file_idea', text: 'Export to CSV (Ada, Acme)' })
  assert.equal(op.text, 'Export to CSV (Ada, Acme)')
  assert.equal(ScheduleOperation.safeParse({ name: 'file_idea', text: ' ' }).success, false)
})
