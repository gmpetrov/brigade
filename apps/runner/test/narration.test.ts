import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentEvent } from '@brigade/contracts'
import { blockKind, EventMapper, NARRATION } from '../src/harness/events.js'

const varint = (n: number) => {
  const out: number[] = []
  do {
    out.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0))
    n >>>= 7
  } while (n)
  return out
}
const field = (number: number, payload: Buffer) =>
  Buffer.from([...varint(number * 8 + 2), ...varint(payload.length), ...payload])

/** A signature shaped as Claude's: its envelope's header names the block's kind (field 8). */
function signature(kind: string) {
  const header = Buffer.concat([
    Buffer.from([0x08, 0x12, 0x18, 0x02, 0x38, 0x01]),
    field(8, Buffer.from(kind)),
  ])
  const envelope = Buffer.concat([field(1, header), field(2, Buffer.alloc(300, 7))])
  return Buffer.concat([Buffer.from([0x08, 0x04]), field(2, envelope)]).toString('base64')
}

test('reads the kind of block a signature names, and nothing from one it cannot read', () => {
  assert.equal(blockKind(signature(NARRATION)), NARRATION)
  assert.equal(blockKind(signature('thinking')), 'thinking')
  assert.equal(blockKind(''), undefined)
  assert.equal(blockKind('not a signature'), undefined)
  assert.equal(blockKind(signature(NARRATION).slice(0, 12)), undefined)
})

function blocks(kind: string | undefined, text: string) {
  const events: AgentEvent[] = []
  const mapper = new EventMapper((event) => events.push(event))
  mapper.map({ type: 'reasoning-start', id: 'b1' })
  mapper.map({ type: 'reasoning-delta', id: 'b1', text })
  mapper.map({
    type: 'reasoning-end',
    id: 'b1',
    ...(kind ? { providerMetadata: { 'claude-code': { signature: signature(kind) } } } : {}),
  })
  return events.map(({ at: _, ...event }) => event)
}

test("the server's summary of what a teammate wrote before a tool call is its message", () => {
  const answer = "C'est normal : la PR #148 n'est pas encore mergée."
  assert.deepEqual(blocks(NARRATION, answer), [{ type: 'message.done', id: 'b1', text: answer }])
})

test('its reasoning stays thinking, with or without a signature', () => {
  const thought = 'The built-in connectors list is fixed.'
  const thinking = { type: 'raw', source: 'reasoning', value: thought }
  assert.deepEqual(blocks('thinking', thought), [thinking])
  assert.deepEqual(blocks(undefined, thought), [thinking])
  // A narration with nothing to read is no message.
  assert.deepEqual(blocks(NARRATION, ' \u200b'), [{ ...thinking, value: ' \u200b' }])
})
