import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentEvent } from '@brigade/contracts'
import {
  AFTER_STEP,
  NO_REPLY,
  ReplyWatch,
  terminalTools,
  UNREAD_WORK,
} from '../src/harness/replies.js'
import { EventMapper } from '../src/harness/events.js'

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

/** The bridge's word: the turn only waits on its background work, or is at it again. */
const waiting = (value: boolean): AgentEvent => ({
  at,
  type: 'raw',
  source: 'harness',
  value: { type: 'system', subtype: 'brigade_waiting', waiting: value },
})

test('a turn that ended while it waited on its background work is asked to read what it reported', () => {
  // Its answer said it waits on an agent; the turn closed before the agent's report was read.
  const watch = turn(call('Agent'), text('Three of four reports are in; waiting on the last one.'))
  watch.see(waiting(true))
  assert.equal(watch.owes(), true, 'the turn is not over for everyone')
  assert.equal(watch.ask(), UNREAD_WORK)
  assert.equal(watch.ask(), undefined, 'asked once')
  // Reading its report, it answered: nothing to ask.
  const read = turn(call('Agent'), text('Waiting on the last report.'), waiting(true))
  read.see(waiting(false))
  read.see(text('All four reports are in: here is the comparison.'))
  assert.equal(read.ask(), undefined)
  // Reading it, it worked on and wrote nothing after: asked what came of it, as any turn.
  const quiet = turn(text('Waiting on the last report.'), waiting(true), waiting(false))
  quiet.see(call('bash'))
  assert.equal(quiet.ask(), AFTER_STEP)
})

test("a turn's background work starts over with each message, and after a restart", () => {
  const watch = turn(text('Waiting on it.'), waiting(true))
  watch.start()
  watch.see(text('Here you go.'))
  assert.equal(watch.ask(), undefined)
  const resumed = turn(waiting(true))
  resumed.resume()
  assert.equal(resumed.ask(), undefined)
})

test('a card written at the end of the reply is its card, and no part of its text', () => {
  const events: AgentEvent[] = []
  const mapper = new EventMapper((event) => events.push(event))
  const reply = 'Je merge #148 et je teste la connexion BigQuery ?'
  mapper.map({ type: 'text-start', id: 't1' })
  mapper.map({
    type: 'text-delta',
    id: 't1',
    text: `${reply}\n\n\`\`\`replies\nMerge #148\nPas encore\n\`\`\``,
  })
  mapper.map({ type: 'text-end', id: 't1' })
  const done = events.filter((e) => e.type !== 'message.delta').map(({ at: _, ...e }) => e)
  const card = { toolCallId: 't1:suggest_replies', toolName: 'suggest_replies' }
  assert.deepEqual(done, [
    { type: 'message.done', id: 't1', text: reply },
    { type: 'tool.started', ...card, input: { replies: ['Merge #148', 'Pas encore'] } },
    { type: 'tool.finished', ...card, output: { shown: 2 }, isError: false },
  ])
  // The reply then ends the turn: nothing is asked of the teammate.
  const watch = new ReplyWatch()
  watch.start()
  for (const event of events) watch.see(event)
  assert.equal(watch.ask(), undefined)
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
