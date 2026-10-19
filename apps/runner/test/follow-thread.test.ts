import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ScheduleOperation } from '@brigade/contracts'
import { childTools, type ScheduleCaller } from '../src/harness/tools.js'

const nothing: ScheduleCaller = async () => ({})

test('follow_thread is offered to a playbook run, never to a child', () => {
  assert.ok(childTools(nothing, { child: false, follow: true }).follow_thread)
  assert.equal(childTools(nothing, { child: false }).follow_thread, undefined)
  assert.equal(childTools(nothing, { child: true, follow: true }).follow_thread, undefined)
})

test('follow_thread sends an operation the API accepts', async () => {
  const sent: Parameters<ScheduleCaller>[0][] = []
  const tools = childTools(
    async (call) => {
      sent.push(call)
      return { ok: true }
    },
    { child: false, follow: true },
  )
  await tools.follow_thread!.execute!({ threadId: 'thread-1' }, {
    toolCallId: 'call-1',
    messages: [],
  } as never)
  assert.deepEqual(sent[0]!.operation, { name: 'follow_thread', threadId: 'thread-1' })
  assert.equal(sent[0]!.toolName, 'follow_thread')
  assert.deepEqual(ScheduleOperation.parse(sent[0]!.operation), {
    name: 'follow_thread',
    threadId: 'thread-1',
  })
})
