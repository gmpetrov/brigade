import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ScheduleOperation } from '@brigade/contracts'
import { appTools, type ScheduleCaller } from '../src/harness/tools.js'

const options = { toolCallId: 'call-1', messages: [] } as never

test("every thread but a playbook's run gets list_apps", () => {
  const nothing: ScheduleCaller = async () => ''
  assert.deepEqual(Object.keys(appTools(nothing, { playbook: false })), ['list_apps'])
  // A playbook's run has only the Apps the playbook declares.
  assert.deepEqual(appTools(nothing, { playbook: true }), {})
})

test('list_apps asks the API, and gives its listing as it is', async () => {
  const sent: Parameters<ScheduleCaller>[0][] = []
  const tools = appTools(
    async (call) => {
      sent.push(call)
      return 'Your accounts, whose tools you have here:\nNone.'
    },
    { playbook: false },
  )
  const output = await tools.list_apps!.execute!({}, options)
  assert.equal(output, 'Your accounts, whose tools you have here:\nNone.')
  assert.deepEqual(ScheduleOperation.parse(sent[0]!.operation), { name: 'list_apps' })
  assert.equal(sent[0]!.toolName, 'list_apps')
})

test('an API from before list_apps says so, rather than "try again differently"', async () => {
  // What an older API answers a call it cannot read (apps/api/src/hub/runner-messages.ts).
  const old: ScheduleCaller = async () => {
    throw new Error(
      'Brigade could not read this call (operation.name: Invalid input). Try again differently.',
    )
  }
  await assert.rejects(appTools(old, { playbook: false }).list_apps!.execute!({}, options), {
    message: /does not have list_apps yet: it is older than this computer's runner/,
  })
  // Any other failure is left as it is.
  const down: ScheduleCaller = async () => {
    throw new Error('The API did not answer in time')
  }
  await assert.rejects(appTools(down, { playbook: false }).list_apps!.execute!({}, options), {
    message: 'The API did not answer in time',
  })
})
