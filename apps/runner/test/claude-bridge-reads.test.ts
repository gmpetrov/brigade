import assert from 'node:assert/strict'
import { test } from 'node:test'
import { claudeSettingsEnv } from '../src/harness/claude-settings.js'
import { SIDE_REPLY_ENV } from '../src/harness/side-reply-env.js'
import { bridgeTurn } from './fixtures/claude-bridge.js'

// Since harness-claude-code 1.0.176, a run that asks before edits (allow-reads) also asks the host
// before a read outside its work directory. A side reply (allow-reads, Read, Glob and Grep) has
// nobody to ask, so the bridge patch lets it read wherever the thread's turn can
// (BRIGADE_READS_ANYWHERE). Runs of no thread (memory, titles) keep the harness's rule: they work
// in an empty folder of their own and are given all they need in their prompt.

/**
 * Claude Code asking about tool calls as it does in a turn: the bridge's PreToolUse hooks first,
 * then, for a call they leave to it and that reaches outside its working directory, canUseTool
 * with the path it blocked. Writes down each call's decisions.
 */
const CALLS_SDK = `import { appendFileSync } from 'node:fs'
const calls = JSON.parse(process.env.FAKE_CALLS)
export function query({ prompt, options }) {
  async function* run() {
    const first = await prompt[Symbol.asyncIterator]().next()
    for (const [i, call] of calls.entries()) {
      const toolUseID = 'toolu_' + i
      const input = { hook_event_name: 'PreToolUse', session_id: 'fake-session', transcript_path: '', cwd: options.cwd, tool_name: call.tool, tool_input: call.input, tool_use_id: toolUseID }
      const hooks = []
      for (const matcher of options.hooks.PreToolUse) {
        if (matcher.matcher && matcher.matcher !== call.tool) continue
        for (const hook of matcher.hooks) {
          const out = await hook(input, toolUseID, { signal: new AbortController().signal })
          if (out?.hookSpecificOutput?.permissionDecision) hooks.push(out.hookSpecificOutput.permissionDecision)
        }
      }
      let asked = null
      if (hooks.length === 0 && call.blockedPath) {
        const answer = await options.canUseTool(call.tool, call.input, { toolUseID, blockedPath: call.blockedPath, signal: new AbortController().signal })
        asked = answer.behavior
      }
      appendFileSync(process.env.FAKE_SDK_RECORD, JSON.stringify({ tool: call.tool, hooks, asked }) + '\\n')
    }
    yield { type: 'system', subtype: 'init', session_id: 'fake-session' }
    yield { type: 'result', subtype: 'success', is_error: false, result: 'done', user_message_uuid: first.value.uuid, session_id: 'fake-session', usage: { input_tokens: 1, output_tokens: 1 } }
  }
  const messages = run()
  messages.interrupt = async () => {}
  return messages
}
`

/** A file outside every work directory, on any computer. */
const OUTSIDE = '/etc/hostname'

type Call = { tool: string; input: Record<string, unknown>; blockedPath?: string }

async function decide(calls: Call[], env: Record<string, string>) {
  const { record, parts } = await bridgeTurn(CALLS_SDK, {
    permissionMode: 'allow-reads',
    activeTools: ['read', 'glob', 'grep'],
    env: { ...env, FAKE_CALLS: JSON.stringify(calls) },
  })
  return {
    record: record as { tool: string; hooks: string[]; asked: string | null }[],
    approvals: parts.filter((p) => p.type === 'tool-approval-request').length,
  }
}

const OUTSIDE_READS: Call[] = [
  { tool: 'Read', input: { file_path: OUTSIDE }, blockedPath: OUTSIDE },
  { tool: 'Grep', input: { pattern: 'x', path: '/etc' }, blockedPath: '/etc' },
  { tool: 'Glob', input: { pattern: '/etc/*.conf' }, blockedPath: '/etc' },
]

test('a side reply reads outside the thread folder without asking anyone', async () => {
  const { record, approvals } = await decide(OUTSIDE_READS, {
    ...claudeSettingsEnv(),
    ...SIDE_REPLY_ENV,
  })
  assert.deepEqual(
    record.map((r) => [r.tool, r.hooks, r.asked]),
    [
      ['Read', [], 'allow'],
      ['Grep', [], 'allow'],
      ['Glob', [], 'allow'],
    ],
  )
  assert.equal(approvals, 0)
})

test('without the side reply setting, the same reads wait for an approval nobody gives', async () => {
  const { record } = await decide(OUTSIDE_READS, claudeSettingsEnv())
  assert.deepEqual(
    record.map((r) => [r.tool, r.hooks]),
    [
      ['Read', ['defer']],
      ['Grep', ['defer']],
      ['Glob', ['defer']],
    ],
  )
})

test('a side reply still asks before anything but a read', async () => {
  const { record } = await decide(
    [{ tool: 'Write', input: { file_path: 'notes.md', content: 'x' } }],
    {
      ...claudeSettingsEnv(),
      ...SIDE_REPLY_ENV,
    },
  )
  assert.deepEqual(record[0]!.hooks, ['defer'])
})
