import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentEvent } from '@brigade/contracts'
import { MISSING_EVENT, readableEvents, storableForms, storableJson } from '../src/storable-json.js'

test('NULs in a tool output are dropped, wherever they are', () => {
  const event = {
    type: 'tool.finished',
    output: { stdout: 'added 877, done\n\u0000\u0000\u0000tail', lines: ['a\u0000b'] },
  }
  assert.deepEqual(storableJson(event), {
    type: 'tool.finished',
    output: { stdout: 'added 877, done\ntail', lines: ['ab'] },
  })
})

test('a lone surrogate becomes U+FFFD; a pair stays', () => {
  assert.equal(storableJson('a\uD800b'), 'a�b')
  assert.equal(storableJson('😀'), '😀')
})

test('the text \\u0000, numbers, booleans and null are left as they are', () => {
  const value = { code: 'replace(/\\u0000/g, "")', n: 1, ok: true, none: null }
  assert.deepEqual(storableJson(value), value)
})

test('an event the database refuses has a cut-short form, then a note that it is missing', () => {
  const long = 'x'.repeat(5000)
  const event = {
    at: 'not a date',
    teammateId: 't1',
    type: 'tool.finished',
    toolCallId: 'c1',
    output: { stdout: `${long}\u0000` },
  } as unknown as AgentEvent
  const [cleaned, cut, missing] = storableForms(event)
  assert.equal((cleaned as { output: { stdout: string } }).output.stdout, long)
  const stdout = (cut as { output: { stdout: string } }).output.stdout
  assert.ok(stdout.length < 2100 && stdout.endsWith('… [cut]'))
  assert.ok(!Number.isNaN(Date.parse(cut!.at)), 'a time the database takes')
  assert.equal((cut as { toolCallId: string }).toolCallId, 'c1')
  assert.deepEqual(missing, {
    at: cut!.at,
    teammateId: 't1',
    type: 'raw',
    source: 'runner',
    value: MISSING_EVENT,
  })
})

test('cutting a string never leaves half of an emoji', () => {
  const event = {
    at: new Date().toISOString(),
    type: 'message.done',
    id: 'm',
    text: `${'x'.repeat(1999)}😀`,
  } as AgentEvent
  const text = (storableForms(event)[1] as { text: string }).text
  assert.ok(text.isWellFormed())
})

test('an event the API cannot read becomes a note in its place; the others are kept', () => {
  const at = new Date().toISOString()
  const good = { sessionId: 's1', seq: 4, event: { at, type: 'message.done', id: 'm', text: 'hi' } }
  const events = readableEvents({
    type: 'events',
    events: [
      { sessionId: 's1', seq: 3, event: { at, type: 'ticket.answered', requestId: null } },
      good,
      { seq: 5, event: {} },
    ],
  })
  assert.equal(events?.length, 2, 'one with no thread or number has no place to go')
  assert.deepEqual(events![0]!.event, {
    at: events![0]!.event.at,
    type: 'raw',
    source: 'runner',
    value: MISSING_EVENT,
  })
  assert.equal(events![0]!.seq, 3)
  assert.deepEqual(events![1], good)
  assert.equal(readableEvents({ type: 'heartbeat' }), undefined)
})
