import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TaskOperation } from '@brigade/contracts'
import { taskTools, type TaskCaller } from '../src/harness/tools.js'

const nothing: TaskCaller = async () => ({})
const options = { toolCallId: 'call-1', messages: [] } as never

test("a playbook's run gets no task tool that starts or prompts a thread outside it", () => {
  assert.deepEqual(Object.keys(taskTools(nothing)).sort(), [
    'assign_task',
    'complete_task',
    'create_task',
    'list_tasks',
    'message_thread',
    'move_task',
    'update_task',
  ])
  assert.deepEqual(Object.keys(taskTools(nothing, { dryRun: false })).sort(), [
    'create_task',
    'list_tasks',
    'message_thread',
    'update_task',
  ])
  assert.deepEqual(Object.keys(taskTools(nothing, { dryRun: true })).sort(), [
    'list_tasks',
    'message_thread',
  ])
})

test("in a live run, create_task files in Backlog and message_thread writes to a child, whatever it's given", async () => {
  const sent: Parameters<TaskCaller>[0][] = []
  const tools = taskTools(
    async (call) => {
      sent.push(call)
      return { ok: true }
    },
    { dryRun: false },
  )
  await tools.create_task!.execute!(
    { title: 'Export to CSV', description: 'Jane asks.', assignee: 'Lee', mission: 'm1' },
    options,
  )
  assert.deepEqual(TaskOperation.parse(sent[0]!.operation), {
    name: 'create',
    title: 'Export to CSV',
    description: 'Jane asks.',
    priority: 'medium',
    assignee: 'none',
  })
  await tools.message_thread!.execute!({ taskId: 't1', threadId: 'child-1', text: 'Hi' }, options)
  assert.deepEqual(TaskOperation.parse(sent[1]!.operation), {
    name: 'comment',
    threadId: 'child-1',
    text: 'Hi',
  })
})
