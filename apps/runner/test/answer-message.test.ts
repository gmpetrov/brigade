import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentEvent } from '@brigade/contracts'
import { EventMapper } from '../src/harness/events.js'
import { answerMessageTool } from '../src/harness/tools.js'

// A person's message given to the running turn, answered at once with answer_message: the
// teammate's message, word for word, which says the message it answers (docs/decisions.md, "A
// turn a person writes into reads as a chat").

function mapped(parts: Record<string, unknown>[], steered?: string) {
  const events: AgentEvent[] = []
  const mapper = new EventMapper(
    (event) => events.push(event),
    undefined,
    undefined,
    undefined,
    () => steered,
  )
  for (const part of parts) mapper.map(part as { type: string })
  return events.map(({ at: _, ...event }) => event)
}

const call = (toolName: string, input: unknown) => ({
  type: 'tool-call',
  toolCallId: 'c1',
  toolName,
  input,
})
const result = { type: 'tool-result', toolCallId: 'c1', toolName: 'answer_message', output: {} }

test('an answer_message call is the teammate message that answers the message steered in last', () => {
  const answer = 'Je ne vois pas ton nom dans cette conversation.'
  assert.deepEqual(mapped([call('answer_message', { text: ` ${answer}\n` }), result], 'msg2'), [
    { type: 'message.done', id: 'c1', text: answer, answers: 'msg2' },
  ])
  // As Claude Code names it, and repeated by the harness: one message.
  const named = call('mcp__harness-tools__answer_message', { text: answer })
  assert.deepEqual(mapped([named, named, result], 'msg2'), [
    { type: 'message.done', id: 'c1', text: answer, answers: 'msg2' },
  ])
})

test('with no message steered in, it is a message of its own; with no answer, a failed step', () => {
  assert.deepEqual(mapped([call('answer_message', { text: 'Oui.' }), result]), [
    { type: 'message.done', id: 'c1', text: 'Oui.' },
  ])
  const error = { type: 'tool-error', toolCallId: 'c1', toolName: 'answer_message', error: 'x' }
  assert.deepEqual(mapped([call('answer_message', { text: ' ​' }), error], 'msg2'), [
    { type: 'tool.started', toolCallId: 'c1', toolName: 'answer_message', input: { text: ' ​' } },
    {
      type: 'tool.finished',
      toolCallId: 'c1',
      toolName: 'answer_message',
      output: 'x',
      isError: true,
    },
  ])
})

test('the tool refuses a call without an answer, so the teammate hears of it', async () => {
  const run = (input: unknown) =>
    answerMessageTool.execute!(input as { text: string }, { toolCallId: 'c1', messages: [] })
  assert.deepEqual(await run({ text: 'Oui.' }), {
    shown: true,
    next: 'Shown under their message. Go on with the work.',
  })
  await assert.rejects(run({ text: '  ' }), /Give your answer as text/)
})
