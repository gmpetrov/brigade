import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentEvent } from '@brigade/contracts'
import { DELTA_EVERY_MS, EventMapper, withoutSignatures } from '../src/harness/events.js'

// A reply's streamed text goes out grouped (DELTA_EVERY_MS): one delta for what came meanwhile,
// never after an event that came after it. And the harness's copies of a sub-agent's messages
// go out without their thinking blocks' signatures.

const timeless = (events: AgentEvent[]) => events.map(({ at: _, ...event }) => event)

function mapped() {
  const events: AgentEvent[] = []
  return { events, mapper: new EventMapper((event) => events.push(event)) }
}

const piece = (text: string, id = 't1') => ({ type: 'text-delta', id, text })
/** What the stream gives between a reply's pieces: low-level echoes, which make no event. */
const echo = { type: 'raw', rawValue: { type: 'stream_event', event: { type: 'ping' } } }

test('a reply streamed in many pieces goes out as one delta, before the message it makes', () => {
  const { events, mapper } = mapped()
  mapper.map({ type: 'text-start', id: 't1' })
  for (const text of ['Je ', 'regarde ', 'la base', '.']) {
    mapper.map(piece(text))
    mapper.map(echo)
  }
  assert.deepEqual(events, [], 'nothing before DELTA_EVERY_MS: the echoes send nothing')
  mapper.map({ type: 'text-end', id: 't1' })
  assert.deepEqual(timeless(events), [
    { type: 'message.delta', id: 't1', text: 'Je regarde la base.' },
    { type: 'message.done', id: 't1', text: 'Je regarde la base.' },
  ])
  // The delta's time is its first piece's.
  assert.ok(Date.parse(events[0]!.at) <= Date.parse(events[1]!.at))
})

test('text streamed for longer goes out each DELTA_EVERY_MS, nothing lost or sent twice', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const { events, mapper } = mapped()
  mapper.map(piece('a'))
  t.mock.timers.tick(DELTA_EVERY_MS - 1)
  mapper.map(piece('b'))
  assert.deepEqual(events, [])
  t.mock.timers.tick(1)
  assert.deepEqual(timeless(events), [{ type: 'message.delta', id: 't1', text: 'ab' }])
  mapper.map(piece('c'))
  mapper.map(piece('d'))
  t.mock.timers.tick(DELTA_EVERY_MS)
  mapper.map(piece('e'))
  mapper.map({ type: 'text-end', id: 't1' })
  // Its timer went with it: nothing more comes later.
  t.mock.timers.tick(DELTA_EVERY_MS * 3)
  assert.deepEqual(timeless(events), [
    { type: 'message.delta', id: 't1', text: 'ab' },
    { type: 'message.delta', id: 't1', text: 'cd' },
    { type: 'message.delta', id: 't1', text: 'e' },
    { type: 'message.done', id: 't1', text: 'abcde' },
  ])
})

test('streamed text goes out before any event that came after it', () => {
  const { events, mapper } = mapped()
  mapper.map(piece('Let me check.'))
  mapper.map({ type: 'tool-call', toolCallId: 'c1', toolName: 'bash', input: { command: 'ls' } })
  mapper.map(piece('Two blocks: ', 'a'))
  mapper.map(piece('this one, then ', 'b'))
  mapper.map(piece('that one.', 'b'))
  mapper.map({ type: 'error', error: new Error('The stream broke') })
  assert.deepEqual(timeless(events), [
    { type: 'message.delta', id: 't1', text: 'Let me check.' },
    { type: 'tool.started', toolCallId: 'c1', toolName: 'bash', input: { command: 'ls' } },
    { type: 'message.delta', id: 'a', text: 'Two blocks: ' },
    { type: 'message.delta', id: 'b', text: 'this one, then that one.' },
    { type: 'error', message: 'The stream broke' },
  ])
})

test('a stream that ends mid-reply sends its last text once it is flushed, and only once', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { events, mapper } = mapped()
  mapper.map(piece('Cut sh'))
  mapper.map(piece('ort'))
  mapper.flush()
  mapper.flush()
  t.mock.timers.tick(DELTA_EVERY_MS * 2)
  assert.deepEqual(timeless(events), [{ type: 'message.delta', id: 't1', text: 'Cut short' }])
})

test("a sub-agent's message goes out without its thinking's signature, the rest as it was", () => {
  const { events, mapper } = mapped()
  const thinking = {
    type: 'thinking',
    thinking: 'Read the schema first.',
    signature: 'EqQBCkY'.repeat(400),
  }
  const call = {
    type: 'tool_use',
    id: 'toolu_1',
    name: 'Read',
    input: { file_path: 'schema.prisma' },
  }
  const value = {
    type: 'assistant',
    parent_tool_use_id: 'toolu_0',
    session_id: 's1',
    message: { id: 'msg_1', role: 'assistant', content: [thinking, call] },
  }
  mapper.map({ type: 'raw', rawValue: value })
  assert.deepEqual(timeless(events), [
    {
      type: 'raw',
      source: 'harness',
      value: {
        ...value,
        message: {
          ...value.message,
          content: [{ type: 'thinking', thinking: 'Read the schema first.' }, call],
        },
      },
    },
  ])
  // What the harness gave is left as it was.
  assert.equal(value.message.content[0], thinking)
  assert.ok('signature' in thinking)
  // A message with no signature is the same value, not a copy.
  const plain = { type: 'assistant', message: { content: [call] } }
  assert.equal(withoutSignatures(plain), plain)
  const system = { type: 'system', subtype: 'task_progress', task_id: 'a1' }
  assert.equal(withoutSignatures(system), system)
})
