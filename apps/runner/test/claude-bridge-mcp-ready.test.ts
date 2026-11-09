import assert from 'node:assert/strict'
import { test } from 'node:test'
import { jsonSchema, tool } from 'ai'
import { claudeSettingsEnv } from '../src/harness/claude-settings.js'
import { bridgeTurn } from './fixtures/claude-bridge.js'

// Claude Code connects its in-process MCP servers (Brigade's tools, `harness-tools`) a moment
// after it starts. A message read before then was answered without them, and Claude Code told the
// model they were "no longer available (MCP server disconnected)": teammates then said the
// library was cut off. The bridge (patched) sends a new process its first message only once
// those servers are connected. This stand-in reports `harness-tools` pending for its first
// 300 ms (or never answers, with FAKE_STATUS_SILENT), and writes down when it was connected
// and when each message came.

const SLOW_SDK = `import { appendFileSync } from 'node:fs'
const note = (what) => appendFileSync(process.env.FAKE_SDK_RECORD, JSON.stringify({ ...what, at: Date.now() }) + '\\n')
export function query({ prompt, options }) {
  const started = Date.now()
  const connected = () => Date.now() - started >= 300
  note({ what: 'query', sdk: Object.entries(options.mcpServers ?? {}).filter(([, c]) => c?.type === 'sdk').map(([n]) => n) })
  async function* run() {
    const base = { session_id: 'fake-session', usage: { input_tokens: 1, output_tokens: 1 } }
    yield { type: 'system', subtype: 'init', session_id: 'fake-session' }
    for await (const message of prompt) {
      const text = message.message.content[0].text
      note({ what: 'message', text, toolsConnected: connected() })
      yield { type: 'assistant', parent_tool_use_id: null, session_id: 'fake-session', message: { id: 'm-' + text, role: 'assistant', content: [{ type: 'text', text: 'Answer to ' + text }] } }
      yield { type: 'result', subtype: 'success', is_error: false, result: 'Answer to ' + text, user_message_uuid: message.uuid, ...base }
    }
  }
  const messages = run()
  messages.interrupt = async () => {}
  messages.mcpServerStatus = process.env.FAKE_STATUS_SILENT ? () => new Promise(() => {}) : async () =>
    Object.entries(options.mcpServers ?? {}).map(([name, c]) => ({ name, status: c?.type === 'sdk' && !connected() ? 'pending' : 'connected' }))
  return messages
}
`

const tools = {
  save_to_library: tool({
    description: 'Save a file to the library.',
    inputSchema: jsonSchema({ type: 'object', properties: {} }),
    execute: async () => 'saved',
  }),
}

test("a new Claude Code process gets its first message once Brigade's tools are connected", async () => {
  const { record } = await bridgeTurn(SLOW_SDK, {
    permissionMode: 'allow-all',
    env: claudeSettingsEnv(),
    tools,
    prompts: ['one', 'two'],
  })
  const queries = record.filter((r) => r.what === 'query')
  assert.ok(queries.length >= 1)
  assert.ok(queries[0].sdk.includes('harness-tools'), JSON.stringify(queries[0]))
  const messages = record.filter((r) => r.what === 'message')
  assert.deepEqual(
    messages.map((m) => m.text),
    ['one', 'two'],
  )
  for (const m of messages) assert.equal(m.toolsConnected, true, JSON.stringify(record))
})

test('a turn without an in-process server waits for nothing', async () => {
  const { record } = await bridgeTurn(SLOW_SDK, {
    permissionMode: 'allow-all',
    env: claudeSettingsEnv(),
    prompts: ['one'],
  })
  const [query] = record.filter((r) => r.what === 'query')
  const [message] = record.filter((r) => r.what === 'message')
  assert.deepEqual(query.sdk, [])
  assert.ok(message.at - query.at < 250, `waited ${message.at - query.at} ms`)
})

// Claude Code that never answers the status (FAKE_STATUS_SILENT): the wait still ends at its
// deadline (BRIGADE_SDK_MCP_READY_MS, 15 s by default), and the message goes in.
test('a status that never comes holds the first message back no longer than the deadline', async () => {
  const { record } = await bridgeTurn(SLOW_SDK, {
    permissionMode: 'allow-all',
    env: { ...claudeSettingsEnv(), BRIGADE_SDK_MCP_READY_MS: '400', FAKE_STATUS_SILENT: '1' },
    tools,
    prompts: ['one'],
  })
  const [query] = record.filter((r) => r.what === 'query')
  const [message] = record.filter((r) => r.what === 'message')
  assert.equal(message?.text, 'one', JSON.stringify(record))
  const waited = message.at - query.at
  assert.ok(waited >= 350 && waited < 3000, `waited ${waited} ms`)
})
