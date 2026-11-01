import assert from 'node:assert/strict'
import { test } from 'node:test'
import { claudeSettingsEnv } from '../src/harness/claude-settings.js'
import { REFUSAL, THREAD_TOOLS } from '../src/harness/thread-tools.js'
import { bridgeTurn } from './fixtures/claude-bridge.js'

// A turn of the Claude Code bridge (patched), with a stand-in for Claude Code that plays what
// a session sends (fixtures/claude-bridge.ts): its background work holds the turn open, and the
// thread's own tools are refused to its sub-agents.

/**
 * Claude Code starting a background sub-agent, answering the person, then hearing the agent's
 * result (with BACKGROUND=0, no agent: the answer is the turn's end). The stand-in writes down
 * when the bridge closed its input, which ends Claude Code's process and its agents with it.
 */
const HOLDING_SDK = `import { appendFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
const note = (what) => appendFileSync(process.env.FAKE_SDK_RECORD, JSON.stringify({ what, at: Date.now() }) + '\\n')
const background = process.env.BACKGROUND !== '0'
export function query({ prompt }) {
  const input = prompt[Symbol.asyncIterator]()
  async function* run() {
    const first = await input.next()
    // Closed input: Claude Code's process ends, and the work it runs in the background with it.
    void input.next().then(() => note('input closed'))
    const base = { session_id: 'fake-session', usage: { input_tokens: 1, output_tokens: 1 } }
    const said = (text) => ({ type: 'assistant', parent_tool_use_id: null, session_id: 'fake-session', message: { id: 'm-' + text, role: 'assistant', content: [{ type: 'text', text }] } })
    yield { type: 'system', subtype: 'init', session_id: 'fake-session' }
    if (background) {
      yield { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'a1', task_type: 'local_agent', description: 'Research' }], session_id: 'fake-session' }
      yield { type: 'system', subtype: 'task_started', task_id: 'a1', task_type: 'local_agent', description: 'Research', session_id: 'fake-session' }
    }
    yield said('Waiting on my agent.')
    yield { type: 'result', subtype: 'success', is_error: false, result: 'Waiting on my agent.', user_message_uuid: first.value.uuid, ...base }
    if (!background) return
    // The agent works on after the turn's answer.
    await sleep(1500)
    note('agent done')
    yield { type: 'system', subtype: 'background_tasks_changed', tasks: [], session_id: 'fake-session' }
    yield { type: 'system', subtype: 'task_notification', task_id: 'a1', status: 'completed', summary: 'Found it', session_id: 'fake-session' }
    // Claude Code's own turn, reading the agent's result.
    yield said('All of it is done.')
    yield { type: 'result', subtype: 'success', is_error: false, result: 'All of it is done.', origin: { kind: 'task-notification' }, ...base }
    await sleep(60_000)
  }
  const messages = run()
  messages.interrupt = async () => {}
  return messages
}
`

const waitingWords = (parts: { type: string; rawValue?: any }[]) =>
  parts
    .filter((p) => p.type === 'raw' && p.rawValue?.subtype === 'brigade_waiting')
    .map((p) => p.rawValue.waiting)

test('a background sub-agent holds the turn open until the teammate has read its result', async () => {
  const { parts, record } = await bridgeTurn(HOLDING_SDK, {
    permissionMode: 'allow-all',
    env: claudeSettingsEnv(),
  })
  const at = (what: string) => record.find((r) => r.what === what)?.at as number | undefined
  // Claude Code's process lives on past the answer: its input closes only after the agent ends.
  assert.ok(at('agent done'), 'the agent got to finish')
  assert.ok(at('input closed')! >= at('agent done')!, 'the input stayed open while the agent ran')
  // The thread hears the turn only waits on it, then that the teammate is at it again.
  assert.deepEqual(waitingWords(parts as never), [true, false])
  // The turn ends once, after the teammate answered the agent's result.
  assert.equal(parts.filter((p) => p.type === 'finish').length, 1)
  const notified = parts.findIndex(
    (p) => p.type === 'raw' && (p.rawValue as any)?.subtype === 'task_notification',
  )
  assert.ok(notified >= 0 && parts.findIndex((p) => p.type === 'finish') > notified)
})

test('with nothing in the background the turn ends at its answer', async () => {
  const { parts, record } = await bridgeTurn(HOLDING_SDK, {
    permissionMode: 'allow-all',
    env: { ...claudeSettingsEnv(), BACKGROUND: '0' },
  })
  assert.ok(record.some((r) => r.what === 'input closed'))
  assert.deepEqual(waitingWords(parts as never), [])
  assert.equal(parts.filter((p) => p.type === 'finish').length, 1)
})

/**
 * Claude Code asking the bridge's PreToolUse hooks about tool calls, as the thread (no
 * agent_id) and as a sub-agent (agent_id, agent_type): it writes down each call's decision.
 */
const HOOKS_SDK = `import { appendFileSync } from 'node:fs'
const calls = JSON.parse(process.env.FAKE_CALLS)
export function query({ prompt, options }) {
  async function* run() {
    const first = await prompt[Symbol.asyncIterator]().next()
    for (const call of calls) {
      const input = { hook_event_name: 'PreToolUse', session_id: 'fake-session', transcript_path: '', cwd: '', tool_name: call.tool, tool_input: {}, ...(call.agent ? { agent_id: 'a1', agent_type: 'general-purpose' } : {}) }
      const decisions = []
      for (const matcher of options.hooks.PreToolUse) {
        if (matcher.matcher && matcher.matcher !== call.tool) continue
        for (const hook of matcher.hooks) {
          const out = await hook(input, 'toolu_' + calls.indexOf(call), { signal: new AbortController().signal })
          if (out?.hookSpecificOutput?.permissionDecision) decisions.push(out.hookSpecificOutput)
        }
      }
      appendFileSync(process.env.FAKE_SDK_RECORD, JSON.stringify({ ...call, decisions }) + '\\n')
    }
    yield { type: 'system', subtype: 'init', session_id: 'fake-session' }
    yield { type: 'result', subtype: 'success', is_error: false, result: 'done', user_message_uuid: first.value.uuid, session_id: 'fake-session', usage: { input_tokens: 1, output_tokens: 1 } }
  }
  const messages = run()
  messages.interrupt = async () => {}
  return messages
}
`

const brigade = (name: string) => `mcp__harness-tools__${name}`

async function decide(
  calls: { tool: string; agent: boolean }[],
  env: Record<string, string> = claudeSettingsEnv(),
) {
  const { record } = await bridgeTurn(HOOKS_SDK, {
    // The bridge's own approvals hook is there too, as in a thread that asks before edits.
    permissionMode: 'allow-reads',
    env: { ...env, FAKE_CALLS: JSON.stringify(calls) },
  })
  return record as {
    tool: string
    agent: boolean
    decisions: { permissionDecision: string; permissionDecisionReason?: string }[]
  }[]
}

test("a sub-agent's call to the thread's own tools is refused, the thread's own goes through", async () => {
  const [subReport, ownReport, subChild, subPull, subSearch, subRead] = await decide([
    { tool: brigade('report'), agent: true },
    { tool: brigade('report'), agent: false },
    { tool: brigade('start_child'), agent: true },
    { tool: brigade('github_create_pull_request_gmpetrov_all_repositorie'), agent: true },
    { tool: brigade('search_workspace'), agent: true },
    { tool: 'Read', agent: true },
  ])
  assert.deepEqual(subReport!.decisions, [
    {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: REFUSAL.replaceAll('{tool}', 'report'),
    },
  ])
  assert.match(
    subReport!.decisions[0]!.permissionDecisionReason!,
    /^Only the thread itself may call report: you are a sub-agent/,
  )
  // The thread's own call: nothing refuses it (Brigade's tools need no approval).
  assert.deepEqual(ownReport!.decisions, [])
  assert.equal(subChild!.decisions[0]!.permissionDecision, 'deny')
  // An App's tool, by its name's start: whichever account it goes through.
  assert.equal(subPull!.decisions[0]!.permissionDecision, 'deny')
  assert.match(subPull!.decisions[0]!.permissionDecisionReason!, /call github_create_pull_request_/)
  // The work itself stays the sub-agent's.
  assert.deepEqual(subSearch!.decisions, [])
  assert.ok(!subRead!.decisions.some((d) => d.permissionDecision === 'deny'))
})

test('each of the thread tools is refused to a sub-agent', async () => {
  const names = THREAD_TOOLS.map((name) => brigade(name.replace(/\*$/, 'some_account')))
  const decided = await decide(names.map((tool) => ({ tool, agent: true })))
  for (const call of decided)
    assert.equal(call.decisions[0]?.permissionDecision, 'deny', `${call.tool} is refused`)
})

test('without the setting, a sub-agent may call report as before', async () => {
  const { BRIGADE_THREAD_TOOLS: _, ...env } = claudeSettingsEnv()
  const [sub] = await decide([{ tool: brigade('report'), agent: true }], env)
  assert.deepEqual(sub!.decisions, [])
})
