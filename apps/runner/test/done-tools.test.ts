import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ScheduleOperation, ThreadSpec } from '@brigade/contracts'
import { THREAD_TOOLS } from '../src/harness/thread-tools.js'
import { doneTools, type ScheduleCaller } from '../src/harness/tools.js'
import { instructions } from '../src/instructions.js'
import { threadMemory } from '../src/memory-layers.js'

// complete_thread (docs/board.md): a thread's teammate declares the work asked in it delivered.
// Only in a thread a person talks to: a child reports, and a playbook's run ends with its report.

const options = { toolCallId: 'call-1', messages: [] } as never
const nothing: ScheduleCaller = async () => ({})

test('complete_thread is only in a thread at the top, not in a child or a playbook’s run', () => {
  assert.deepEqual(Object.keys(doneTools(nothing, { child: false, playbook: false })), [
    'complete_thread',
  ])
  assert.deepEqual(doneTools(nothing, { child: true, playbook: false }), {})
  assert.deepEqual(doneTools(nothing, { child: false, playbook: true }), {})
  assert.deepEqual(doneTools(nothing, { child: true, playbook: true }), {})
})

test('complete_thread is the thread’s own: refused to its sub-agents', () => {
  // A sub-agent sees only its part of the work: it never declares the whole thread done.
  assert.ok(THREAD_TOOLS.includes('complete_thread'))
})

test('complete_thread sends its line as one line, and refuses none or one too long', async () => {
  const sent: Parameters<ScheduleCaller>[0][] = []
  const tools = doneTools(
    async (call) => {
      sent.push(call)
      return { done: { summary: 'x' } }
    },
    { child: false, playbook: false },
  )
  await tools.complete_thread!.execute!({ summary: '  CSV export merged\n(#412)  ' }, options)
  assert.deepEqual(ScheduleOperation.parse(sent[0]!.operation), {
    name: 'complete_thread',
    summary: 'CSV export merged (#412)',
  })
  assert.equal(sent[0]!.toolName, 'complete_thread')
  await assert.rejects(tools.complete_thread!.execute!({ summary: '   ' }, options), {
    message: /what was delivered/,
  })
  await assert.rejects(tools.complete_thread!.execute!({ summary: 'x'.repeat(301) }, options), {
    message: /At most 300 characters/,
  })
  assert.equal(sent.length, 1, 'a line refused here never reaches the API')
})

test('an API from before complete_thread says so, rather than "try again differently"', async () => {
  const old: ScheduleCaller = async () => {
    throw new Error(
      'Brigade could not read this call (operation.name: Invalid input). Try again differently.',
    )
  }
  const tools = doneTools(old, { child: false, playbook: false })
  await assert.rejects(tools.complete_thread!.execute!({ summary: 'Shipped' }, options), {
    message: /does not have complete_thread yet: it is older than this computer's runner/,
  })
  // Its refusal, listing what is open, is left as it is.
  const refused: ScheduleCaller = async () => {
    throw new Error('Not done yet: something is still open in this thread.')
  }
  await assert.rejects(
    doneTools(refused, { child: false, playbook: false }).complete_thread!.execute!(
      { summary: 'Shipped' },
      options,
    ),
    { message: /^Not done yet/ },
  )
})

const spec = (extra: Record<string, unknown>) =>
  ThreadSpec.parse({
    sessionId: 's1',
    teammate: { id: 'riley', name: 'Riley', instructions: '', harness: 'claude_code', model: null },
    permissionMode: 'allow-all',
    account: { id: 'a1', provider: 'claude_code', source: 'machine' },
    fallbacks: [],
    teammates: [{ id: 'riley', name: 'Riley' }],
    ...extra,
  })
const told = (s: ThreadSpec) =>
  instructions(s, threadMemory(s, { workspace: '', teammate: '' }, '/threads/s1'), '/library', {
    ready: true,
  })

test('a thread at the top is told to declare its work done, and that a merge wakes it', () => {
  const top = told(spec({}))
  assert.match(top, /## Done\n\nWhen the work asked in this thread is delivered/)
  assert.match(top, /call `complete_thread` in the same turn/)
  assert.match(top, /you are woken here once it is merged/)
  assert.doesNotMatch(top, /the thread tells you once it is merged/)
  // A child reports: no such section, and a merge only leaves a note there.
  const child = told(spec({ parent: { id: 'p1', title: 'Launch' } }))
  assert.doesNotMatch(child, /## Done\n/)
  assert.doesNotMatch(child, /complete_thread/)
  assert.match(child, /the thread notes it once it is merged/)
})
