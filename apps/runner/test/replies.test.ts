import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentEvent } from '@brigade/contracts'
import { AFTER_STEP, NO_REPLY, ReplyWatch, terminalTools } from '../src/harness/replies.js'
import { offerChoicesTool, suggestRepliesTool } from '../src/harness/tools.js'

const at = '2026-10-16T18:00:00.000Z'
const text = (value: string): AgentEvent => ({ at, type: 'message.done', id: value, text: value })
const call = (toolName: string): AgentEvent => ({
  at,
  type: 'tool.started',
  toolCallId: toolName,
  toolName,
  input: {},
})
const thinking: AgentEvent = { at, type: 'raw', source: 'reasoning', value: 'The answer is…' }

function turn(...events: AgentEvent[]) {
  const watch = new ReplyWatch()
  watch.start()
  for (const event of events) watch.see(event)
  return watch
}

test('an answer before a card, its plan or a wake-up is the reply: nothing is asked again', () => {
  for (const aside of ['suggest_replies', 'TodoWrite', 'ToolSearch', 'set_wakeup', 'complete_task'])
    assert.equal(turn(call('bash'), text('Here is what I found…'), call(aside)).ask(), undefined)
  // A card refused and called again is still no work after the answer.
  assert.equal(
    turn(text('Here is what I found…'), call('suggest_replies'), call('suggest_replies')).ask(),
    undefined,
  )
})

test('a turn the person read nothing of is asked for its reply', () => {
  // The answer only in its thinking, then reply buttons.
  assert.equal(turn(thinking, call('suggest_replies')).ask(), NO_REPLY)
  // A lone zero-width space is no reply.
  assert.equal(turn(call('bash'), text('\u200b')).ask(), NO_REPLY)
})

test('a turn that ended on work after its text is asked what came of it, not to repeat it', () => {
  assert.equal(turn(text('Running the tests.'), call('bash')).ask(), AFTER_STEP)
  assert.match(AFTER_STEP, /do not repeat that/)
  assert.equal(turn(text('Running the tests.'), call('bash'), text('All pass.')).ask(), undefined)
})

test('asked once, and never after a restart', () => {
  const watch = turn(call('bash'))
  assert.equal(watch.ask(), NO_REPLY)
  assert.equal(watch.ask(), undefined)
  const resumed = new ReplyWatch()
  resumed.resume()
  resumed.see(call('bash'))
  assert.equal(resumed.ask(), undefined)
})

test('a message steered into the turn needs a reply of its own, after what was read', () => {
  const read = turn(text('Here is the plan…'))
  read.steered()
  assert.equal(read.ask(), AFTER_STEP)
  const answered = turn(text('Here is the plan…'))
  answered.steered()
  answered.see(text('Done, with the change you asked for.'))
  assert.equal(answered.ask(), undefined)
  const silent = turn(call('bash'))
  silent.steered()
  assert.equal(silent.ask(), NO_REPLY)
})

test('a card never tells the teammate to write a reply it may have written', async () => {
  const replies = (await suggestRepliesTool.execute!(
    { replies: ['Send it'] },
    {
      toolCallId: 'c1',
      messages: [],
    },
  )) as { next: string }
  assert.match(replies.next, /If you have not written that reply yet/)
  assert.match(replies.next, /if you have, your turn is over/)
  const choices = (await offerChoicesTool.execute!(
    {
      question: 'Which one?',
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
    },
    { toolCallId: 'c2', messages: [] },
  )) as { next: string }
  assert.match(choices.next, /if you have, your turn is over/)
  assert.doesNotMatch(String(suggestRepliesTool.description), /summarized/)
})

test("every tool ends a turn for Claude Code: Brigade's by its MCP name, and its own", () => {
  const names = terminalTools([
    'suggest_replies',
    'set_wakeup',
  ]).CLAUDE_CODE_TERMINAL_MCP_TOOLS.split(',')
  assert.ok(names.includes('mcp__harness-tools__suggest_replies'))
  assert.ok(names.includes('mcp__harness-tools__set_wakeup'))
  for (const own of ['Bash', 'Read', 'TodoWrite', 'ToolSearch']) assert.ok(names.includes(own))
})
