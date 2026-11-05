import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ScheduleOperation } from '@brigade/contracts'
import { playbookTools, startedThreadTools, type ScheduleCaller } from '../src/harness/tools.js'

const nothing: ScheduleCaller = async () => ({})
const options = { toolCallId: 'call-1', messages: [] } as never

test("a playbook's run gets no tool that starts a thread outside it, and writes only in its children", () => {
  assert.deepEqual(Object.keys(startedThreadTools(nothing, { playbook: false })).sort(), [
    'message_thread',
    'start_thread',
  ])
  assert.deepEqual(Object.keys(startedThreadTools(nothing, { playbook: true })), ['message_thread'])
  // It keeps an idea for the team instead, in the playbook's ideas list.
  assert.ok('file_idea' in playbookTools(nothing))
})

test('start_thread and message_thread send what the API checks, whatever they are given', async () => {
  const sent: Parameters<ScheduleCaller>[0][] = []
  const tools = startedThreadTools(
    async (call) => {
      sent.push(call)
      return { ok: true }
    },
    { playbook: false },
  )
  await tools.start_thread!.execute!(
    {
      title: 'Fix the export',
      brief: 'Exports fail with a 500.',
      teammate: 'Cody',
      project: 'none',
      list: 'Projects/Acme/backlog.md',
      items: ['Fix the export'],
    },
    options,
  )
  assert.deepEqual(ScheduleOperation.parse(sent[0]!.operation), {
    name: 'start_thread',
    title: 'Fix the export',
    brief: 'Exports fail with a 500.',
    teammate: 'Cody',
    project: null,
    list: 'Projects/Acme/backlog.md',
    items: ['Fix the export'],
  })
  // Unset, it is for the teammate calling, in this thread's project.
  await tools.start_thread!.execute!({ title: 'Plan the webinar', brief: 'In December.' }, options)
  assert.deepEqual(ScheduleOperation.parse(sent[1]!.operation), {
    name: 'start_thread',
    title: 'Plan the webinar',
    brief: 'In December.',
  })
  await tools.message_thread!.execute!({ threadId: 't1', text: 'Also the PDF.' }, options)
  assert.deepEqual(ScheduleOperation.parse(sent[2]!.operation), {
    name: 'message_thread',
    threadId: 't1',
    text: 'Also the PDF.',
  })
})

test("in a playbook's run, message_thread still names only the thread it is given", async () => {
  const sent: Parameters<ScheduleCaller>[0][] = []
  const tools = startedThreadTools(
    async (call) => {
      sent.push(call)
      return { ok: true }
    },
    { playbook: true },
  )
  await tools.message_thread!.execute!({ threadId: 'child-1', text: 'Hi' }, options)
  assert.deepEqual(sent[0]!.operation, { name: 'message_thread', threadId: 'child-1', text: 'Hi' })
})
