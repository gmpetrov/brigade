// A reply's deltas leave the runner with their secrets masked, each with the text before it
// (EventMapper, MaskedStream), and marked so: a secret the harness streams over several
// deltas never goes out in part. Made-up secrets, built from parts.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentEvent } from '@brigade/contracts'
import { EventMapper } from '../src/harness/events.js'

const token = ['ghp', 'aB3cD5eF7gH9iJ2kL4mN6pQ8rS1tU0vWxY2z'].join('_')
const bearer = ['r8', 'Ab3Cd5Ef7Gh9iJ2kL4mN6pQ8rS1tU0vW'].join('_')

function stream(pieces: string[], texts = new Map<string, string>()) {
  const events: AgentEvent[] = []
  const mapper = new EventMapper((event) => events.push(event), new Map(), texts)
  mapper.map({ type: 'text-start', id: 't1' })
  for (const text of pieces) mapper.map({ type: 'text-delta', id: 't1', text })
  return { events, mapper }
}
const deltas = (events: AgentEvent[]) =>
  events.flatMap((e) => (e.type === 'message.delta' ? [e.text] : []))

test('a token and a header streamed in pieces go out masked; the done holds the reply', () => {
  const reply = `Use ${token} with Authorization: Bearer ${bearer} please.`
  const { events, mapper } = stream(reply.match(/[\s\S]{1,3}/g)!)
  mapper.map({ type: 'text-end', id: 't1' })
  const out = deltas(events).join('')
  assert.equal(
    out,
    'Use [redacted: a GitHub token] with Authorization: Bearer [redacted: a token] ',
  )
  assert.ok(!out.includes(token.slice(4, 12)) && !out.includes(bearer.slice(3, 11)))
  // No delta is sent while what it holds may start a secret: no empty one either. Each is
  // marked masked, which the API keeps the text of (an unmarked one, from before, it drops).
  assert.ok(deltas(events).every((d) => d.length > 0))
  assert.ok(events.every((e) => e.type !== 'message.delta' || e.masked === true))
  // The whole reply in its done, which the API masks as it stores it.
  assert.equal(events.find((e) => e.type === 'message.done')?.type, 'message.done')
})

test('a block handed over halfway goes on masked with its text so far', () => {
  const texts = new Map([['t1', 'Here: ghp_']])
  const { events } = stream([`${token.slice(4)} done `], texts)
  assert.deepEqual(deltas(events), ['[redacted: a GitHub token] done '])
})
