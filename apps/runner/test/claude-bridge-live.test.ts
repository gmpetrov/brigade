import assert from 'node:assert/strict'
import { test } from 'node:test'
import { claudeSettingsEnv } from '../src/harness/claude-settings.js'
import { connectorTools } from '../src/harness/tools.js'
import { bridgeTurn } from './fixtures/claude-bridge.js'

// Claude Code's process kept from one turn to the next (the patched bridge's liveQuery): a
// stand-in for Claude Code that answers each message it reads, for as long as its input is
// open, and writes down each query (each process) and each message.

const LIVE_SDK = `import { appendFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
const note = (what) => appendFileSync(process.env.FAKE_SDK_RECORD, JSON.stringify(what) + '\\n')
let queries = 0
export function query({ prompt, options }) {
  const id = ++queries
  note({ what: 'query', id, resume: options.resume ?? null, continue: options.continue ?? null })
  let client
  async function* run() {
    const base = { session_id: 'fake-session', usage: { input_tokens: 1, output_tokens: 1 } }
    yield { type: 'system', subtype: 'init', session_id: 'fake-session' }
    for await (const message of prompt) {
      const text = message.message.content[0].text
      note({ what: 'message', id, text })
      if (text === 'fail') {
        yield { type: 'result', subtype: 'success', is_error: true, result: 'It broke', user_message_uuid: message.uuid, ...base }
        continue
      }
      // A host tool's call goes to the turn that reads this message.
      if (text.startsWith('call ')) {
        if (!client) {
          const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
          client = new Client({ name: 'claude-code', version: '0' })
          await Promise.all([options.mcpServers['harness-tools'].instance.connect(serverSide), client.connect(clientSide)])
        }
        const result = await client.callTool({ name: text.slice(5), arguments: {} })
        note({ what: 'tool', id, result: result.content[0].text })
      }
      const said = 'Answer to ' + text
      const ev = (event) => ({ type: 'stream_event', parent_tool_use_id: null, session_id: 'fake-session', event })
      yield ev({ type: 'message_start', message: { id: 'm-' + text, role: 'assistant', content: [], usage: base.usage } })
      yield ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      yield ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: said } })
      yield ev({ type: 'content_block_stop', index: 0 })
      yield ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: base.usage })
      yield ev({ type: 'message_stop' })
      yield { type: 'assistant', parent_tool_use_id: null, session_id: 'fake-session', message: { id: 'm-' + text, role: 'assistant', content: [{ type: 'text', text: said }] } }
      yield { type: 'result', subtype: 'success', is_error: false, result: 'Answer to ' + text, user_message_uuid: message.uuid, ...base }
      // Its guess at the person's next message, once the turn is over.
      if (options.promptSuggestions) yield { type: 'prompt_suggestion', suggestion: 'After ' + text, session_id: 'fake-session' }
    }
    note({ what: 'input closed', id })
  }
  const messages = run()
  messages.interrupt = async () => {}
  return messages
}
`

const texts = (parts: { type: string; [key: string]: unknown }[]) =>
  parts.filter((p) => p.type === 'text-delta').map((p) => p.text ?? p.delta)

test("a thread's turns go to one Claude Code process, each prompt as its next message", async () => {
  const { turns, record } = await bridgeTurn(LIVE_SDK, {
    permissionMode: 'allow-all',
    env: claudeSettingsEnv(),
    prompts: ['one', 'two', 'three'],
  })
  assert.equal(record.filter((r) => r.what === 'query').length, 1, JSON.stringify(record))
  assert.deepEqual(
    record.filter((r) => r.what === 'message').map((r) => r.text),
    ['one', 'two', 'three'],
  )
  // Each turn ends at its own answer, and hears only its own.
  assert.equal(turns.length, 3)
  for (const [i, word] of ['one', 'two', 'three'].entries()) {
    assert.equal(
      turns[i]!.filter((p) => p.type === 'finish').length,
      1,
      `turn ${word} finished once`,
    )
    assert.deepEqual(texts(turns[i]!), [`Answer to ${word}`])
  }
  // The bridge's end ends the process.
  assert.ok(record.some((r) => r.what === 'input closed'))
})

test('with BRIGADE_CLAUDE_KEEP_MS=0, each turn starts Claude Code anew, as before', async () => {
  const { record } = await bridgeTurn(LIVE_SDK, {
    permissionMode: 'allow-all',
    env: { ...claudeSettingsEnv(), BRIGADE_CLAUDE_KEEP_MS: '0' },
    prompts: ['one', 'two'],
  })
  const queries = record.filter((r) => r.what === 'query')
  assert.equal(queries.length, 2)
  // The second resumes the session the first reported.
  assert.equal(queries[1]!.resume, 'fake-session')
})

test('a turn that fails ends the process: the next starts a new one, resuming the session', async () => {
  const { turns, record } = await bridgeTurn(LIVE_SDK, {
    permissionMode: 'allow-all',
    env: claudeSettingsEnv(),
    prompts: ['fail', 'after'],
  })
  assert.ok(turns[0]!.some((p) => p.type === 'error'))
  const queries = record.filter((r) => r.what === 'query')
  assert.equal(queries.length, 2, JSON.stringify(record))
  assert.equal(queries[1]!.resume, 'fake-session')
  assert.deepEqual(texts(turns[1]!), ['Answer to after'])
})

test('where a turn may wait on an approval, Claude Code is not kept', async () => {
  const { record } = await bridgeTurn(LIVE_SDK, {
    permissionMode: 'allow-reads',
    env: claudeSettingsEnv(),
    prompts: ['one', 'two'],
  })
  assert.equal(record.filter((r) => r.what === 'query').length, 2)
})

test("a kept process's host tool call reaches the turn running now", async () => {
  const calls: string[] = []
  const tools = connectorTools(
    [
      {
        connectionId: 'c1',
        kind: 'linear',
        label: 'Linear',
        scope: 'read',
        operations: [
          {
            name: 'linear_whoami',
            description: 'Who am I',
            write: false,
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      } as never,
    ],
    async (call) => {
      calls.push(call.toolCallId)
      return `answer ${calls.length}`
    },
  )
  const { turns, record } = await bridgeTurn(LIVE_SDK, {
    permissionMode: 'allow-all',
    env: claudeSettingsEnv(),
    tools,
    prompts: ['call linear_whoami', 'call linear_whoami'],
  })
  assert.equal(record.filter((r) => r.what === 'query').length, 1)
  assert.deepEqual(
    record.filter((r) => r.what === 'tool').map((r) => JSON.parse(r.result)),
    ['answer 1', 'answer 2'],
  )
  // Each call is its turn's: the second turn's stream has the second call and its result.
  for (const parts of turns) {
    assert.equal(parts.filter((p) => p.type === 'tool-call').length, 1)
    assert.equal(parts.filter((p) => p.type === 'tool-result').length, 1)
  }
})

test("Claude Code's guess at the next message ends an answered turn, and the process stays", async () => {
  const { turns, record } = await bridgeTurn(LIVE_SDK, {
    permissionMode: 'allow-all',
    env: { ...claudeSettingsEnv(), BRIGADE_PROMPT_SUGGESTIONS: '1' },
    prompts: ['one', 'two'],
  })
  assert.equal(record.filter((r) => r.what === 'query').length, 1, JSON.stringify(record))
  for (const [i, word] of ['one', 'two'].entries()) {
    const raw = turns[i]!.filter((p) => p.type === 'raw').map((p) => p.rawValue as any)
    assert.ok(
      raw.some((r) => r.subtype === 'brigade_answered'),
      `turn ${word} said it was answered`,
    )
    // Each turn's own guess, not the one before.
    assert.deepEqual(
      raw.filter((r) => r.type === 'prompt_suggestion').map((r) => r.suggestion),
      [`After ${word}`],
    )
    assert.equal(turns[i]!.filter((p) => p.type === 'finish').length, 1)
  }
})
