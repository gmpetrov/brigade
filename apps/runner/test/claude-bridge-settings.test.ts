import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CLAUDE_SETTINGS, claudeSettingsEnv } from '../src/harness/claude-settings.js'
import { bridgeTurn } from './fixtures/claude-bridge.js'

// The Claude Code bridge (patched) builds its own settings for Claude Code, which went in
// over Brigade's: these runs go through it (fixtures/claude-bridge.ts), with an Agent SDK that
// only writes down the options each query gets, so what Claude Code would be given is checked.

const FAKE_SDK = `import { appendFileSync } from 'node:fs'
const plain = (value) =>
  JSON.parse(JSON.stringify(value, (key, v) => (typeof v === 'function' || ['abortSignal', 'hooks', 'mcpServers'].includes(key) ? undefined : v)))
export function query({ prompt, options }) {
  appendFileSync(process.env.FAKE_SDK_RECORD, JSON.stringify(plain(options)) + '\\n')
  async function* run() {
    await prompt[Symbol.asyncIterator]().next()
    yield { type: 'system', subtype: 'init', session_id: 'fake-session' }
    yield { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'fake-session', usage: { input_tokens: 1, output_tokens: 1 } }
  }
  const messages = run()
  messages.interrupt = async () => {}
  return messages
}
`

async function queryOptions(
  permissionMode: 'allow-all' | 'allow-reads',
  env: Record<string, string>,
): Promise<Record<string, any>> {
  const { record } = await bridgeTurn(FAKE_SDK, { permissionMode, env })
  assert.equal(record.length, 1)
  return record[0]
}

test("Brigade's settings reach Claude Code in a thread that asks before nothing", async () => {
  const options = await queryOptions('allow-all', claudeSettingsEnv())
  assert.equal(options.settings.autoMemoryEnabled, false)
  assert.deepEqual(options.settings.permissions.deny, CLAUDE_SETTINGS.permissions.deny)
  assert.equal(options.permissionMode, 'bypassPermissions')
  assert.equal(options.promptSuggestions, undefined)
})

test('they join the rules the bridge sets when its permission mode asks before edits', async () => {
  const options = await queryOptions('allow-reads', claudeSettingsEnv())
  assert.equal(options.settings.autoMemoryEnabled, false)
  assert.deepEqual(options.settings.permissions.deny, CLAUDE_SETTINGS.permissions.deny)
  // The bridge's own: asks before edits and commands, and never runs one as sandboxed on its own.
  assert.ok(options.settings.permissions.ask.includes('Bash(*)'))
  assert.ok(options.settings.permissions.ask.includes('Write(*)'))
  assert.equal(options.settings.sandbox.autoAllowBashIfSandboxed, false)
})

test('a run without Brigade settings gets the bridge’s alone', async () => {
  const options = await queryOptions('allow-reads', {})
  assert.equal('autoMemoryEnabled' in options.settings, false)
  assert.equal('deny' in options.settings.permissions, false)
  assert.ok(options.settings.permissions.ask.includes('Bash(*)'))
})

test('Claude Code guesses the next message where the thread wants it', async () => {
  const options = await queryOptions('allow-all', {
    ...claudeSettingsEnv(),
    BRIGADE_PROMPT_SUGGESTIONS: '1',
  })
  assert.equal(options.promptSuggestions, true)
  assert.equal(options.settings.autoMemoryEnabled, false)
})
