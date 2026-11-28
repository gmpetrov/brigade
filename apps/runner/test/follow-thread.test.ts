import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ScheduleOperation } from '@brigade/contracts'
import { childTools, type ScheduleCaller } from '../src/harness/tools.js'

const nothing: ScheduleCaller = async () => ({})

test('before the tree, follow_thread is offered to a playbook run, never to a child', () => {
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

// Sub-threads (docs/sub-threads.md): what a thread is offered depends on its level, and only where
// its API says the tree (ThreadSpec.tree): an older API would drop the new fields.

const tree = (level: number) => ({ level, rootId: 'root-1' })

test('where its API says the tree, a level-1 sub-thread starts its own and a level-2 one does not', () => {
  const one = childTools(nothing, { child: true, follow: true, tree: tree(1) })
  assert.ok(one.start_child && one.cancel_child && one.report && one.follow_thread)
  const two = childTools(nothing, { child: true, follow: true, tree: tree(2) })
  assert.equal(two.start_child, undefined)
  assert.ok(two.report && two.follow_thread)
  // An older API: a child starts none, as before.
  assert.equal(childTools(nothing, { child: true }).start_child, undefined)
})

test('start_child sends the new fields only where the tree is said', async () => {
  const sent: Parameters<ScheduleCaller>[0][] = []
  const record: ScheduleCaller = async (call) => {
    sent.push(call)
    return { ok: true }
  }
  const input = {
    title: 'Render the video',
    instructions: 'Render it. Why a sub-thread: it takes an hour, on the cloud computer.',
    computer: "Ada's Mac",
    files: ['/tmp/brief.md'],
    repos: [{ repository: 'acme/site', branch: 'brigade/riley-kit' }],
    wake: 'each' as const,
  }
  const options = { toolCallId: 'call-1', messages: [] } as never
  await childTools(record, { child: false, tree: tree(0) }).start_child!.execute!(input, options)
  assert.deepEqual(sent[0]!.operation, {
    name: 'start_child',
    title: input.title,
    instructions: input.instructions,
    wait: true,
    computer: { mine: "Ada's Mac" },
    files: ['/tmp/brief.md'],
    repos: input.repos,
    wake: 'each',
  })
  // Files go by path here: the harness sends them first and passes their ids (reportWithFiles).
  assert.equal(
    ScheduleOperation.safeParse({ ...sent[0]!.operation, files: ['att-1'] }).success,
    true,
  )
  await childTools(record, { child: false, tree: tree(0) }).start_child!.execute!(
    { ...input, computer: 'Cloud' },
    options,
  )
  assert.equal((sent[1]!.operation as { computer?: unknown }).computer, 'cloud')
  // An older API: as before, nothing it would drop.
  await childTools(record, { child: false }).start_child!.execute!(input, options)
  assert.deepEqual(sent[2]!.operation, {
    name: 'start_child',
    title: input.title,
    instructions: input.instructions,
    wait: true,
  })
  const schema = (t: ReturnType<typeof childTools>) =>
    JSON.stringify((t.start_child!.inputSchema as { jsonSchema: unknown }).jsonSchema)
  assert.doesNotMatch(schema(childTools(nothing, { child: false })), /"computer"/)
  assert.match(schema(childTools(nothing, { child: false, tree: tree(0) })), /"computer"/)
})

test('needs_parent is a report status only where the tree is said', () => {
  const statuses = (t: ReturnType<typeof childTools>) =>
    JSON.stringify((t.report!.inputSchema as { jsonSchema: unknown }).jsonSchema)
  assert.match(statuses(childTools(nothing, { child: true, tree: tree(1) })), /needs_parent/)
  assert.doesNotMatch(statuses(childTools(nothing, { child: true })), /needs_parent/)
})
