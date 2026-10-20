import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentEvent } from '@brigade/contracts'
import { answered, EventMapper } from '../src/harness/events.js'
import { ReplyWatch } from '../src/harness/replies.js'

const at = '2026-10-20T15:00:00.000Z'

function mapped(...parts: { type: string; [key: string]: unknown }[]) {
  const events: AgentEvent[] = []
  const mapper = new EventMapper((event) => events.push(event))
  for (const part of parts) mapper.map(part)
  return events.map(({ at: _, ...event }) => event)
}

test("Claude Code's guess at the next message becomes the thread's suggestion", () => {
  const guess = { type: 'prompt_suggestion', suggestion: ' Corrige-le et ouvre une PR ' }
  assert.deepEqual(mapped({ type: 'raw', rawValue: guess }), [
    { type: 'message.suggested', text: 'Corrige-le et ouvre une PR' },
  ])
  // An empty guess is none, nor one of Claude Code's own commands; a long one is cut.
  assert.deepEqual(
    mapped({ type: 'raw', rawValue: { type: 'prompt_suggestion', suggestion: ' ' } }),
    [],
  )
  assert.deepEqual(
    mapped({ type: 'raw', rawValue: { type: 'prompt_suggestion', suggestion: '/compact' } }),
    [],
  )
  const long = mapped({
    type: 'raw',
    rawValue: { type: 'prompt_suggestion', suggestion: 'x'.repeat(900) },
  })
  assert.equal((long[0] as { text: string }).text.length, 300)
})

test("the bridge's word that the turn is answered stays the runner's", () => {
  const word = { type: 'system', subtype: 'brigade_answered' }
  const [event] = mapped({ type: 'raw', rawValue: word })
  assert.ok(answered({ at, ...event } as AgentEvent))
  const waiting = { type: 'system', subtype: 'brigade_waiting', waiting: true }
  const [other] = mapped({ type: 'raw', rawValue: waiting })
  assert.ok(!answered({ at, ...other } as AgentEvent))
  assert.ok(!answered({ at, type: 'turn.completed', finishReason: 'stop' }))
})

test('a turn owes a reply until the person has read one after its last step', () => {
  const watch = new ReplyWatch()
  watch.start()
  assert.equal(watch.owes(), true)
  watch.see({ at, type: 'message.done', id: 't1', text: 'Voilà ce que j’ai trouvé.' })
  assert.equal(watch.owes(), false)
  watch.see({ at, type: 'tool.started', toolCallId: 'b', toolName: 'Bash', input: {} })
  assert.equal(watch.owes(), true)
  // Owing is no asking: ask() still asks once.
  assert.ok(watch.ask())
  assert.equal(watch.owes(), false)
})
