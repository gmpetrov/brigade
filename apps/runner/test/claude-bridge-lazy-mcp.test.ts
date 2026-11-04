import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { claudeSettingsEnv } from '../src/harness/claude-settings.js'
import { bridgeTurn } from './fixtures/claude-bridge.js'

// An MCP server on stdio marked `lazy` (the browser's relay): the patched bridge serves its tool
// list itself, as the server listed it last time, and starts the server at its first tool call.

const require = createRequire(import.meta.url)
const sdk = (path: string) =>
  pathToFileURL(require.resolve(`@modelcontextprotocol/sdk/${path}`)).href

/** A stdio MCP server with one tool, writing down when it starts and each call. */
const server = (record: string) => `import { appendFileSync } from 'node:fs'
import { McpServer } from '${sdk('server/mcp.js')}'
import { StdioServerTransport } from '${sdk('server/stdio.js')}'
const note = (what) => appendFileSync(${JSON.stringify(record)}, JSON.stringify({ what }) + '\\n')
note('server started')
const server = new McpServer({ name: 'browser', version: '1.0.0' })
server.registerTool('navigate', { description: 'Go to a page' }, async () => {
  note('navigate')
  return { content: [{ type: 'text', text: 'went' }] }
})
await server.connect(new StdioServerTransport())
`

/** Claude Code connecting to the browser server: each prompt lists its tools, or calls one. */
const LAZY_SDK = `import { appendFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
const note = (what) => appendFileSync(process.env.FAKE_SDK_RECORD, JSON.stringify(what) + '\\n')
export function query({ prompt, options }) {
  let client
  async function* run() {
    const base = { session_id: 'fake-session', usage: { input_tokens: 1, output_tokens: 1 } }
    yield { type: 'system', subtype: 'init', session_id: 'fake-session' }
    for await (const message of prompt) {
      const text = message.message.content[0].text
      if (!client) {
        const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
        client = new Client({ name: 'claude-code', version: '0' })
        await Promise.all([options.mcpServers.browser.instance.connect(serverSide), client.connect(clientSide)])
        note({ what: 'tools', names: (await client.listTools()).tools.map((t) => t.name) })
      }
      if (text === 'call') {
        const result = await client.callTool({ name: 'navigate', arguments: {} })
        note({ what: 'result', text: result.content[0].text })
      }
      yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', user_message_uuid: message.uuid, ...base }
    }
  }
  const messages = run()
  messages.interrupt = async () => {}
  return messages
}
`

test('a lazy MCP server starts at its first tool call, its tool list kept from the last time', async () => {
  const home = await mkdtemp(join(tmpdir(), 'lazy-mcp-'))
  const serverRecord = join(home, 'server.jsonl')
  const script = join(home, 'server.mjs')
  await writeFile(script, server(serverRecord))
  const mcpServers = {
    browser: { command: process.execPath, args: [script], lazy: `test-browser\0${script}` },
  }
  const started = async () =>
    (await readFile(serverRecord, 'utf8').catch(() => ''))
      .split('\n')
      .filter((line) => line.includes('server started')).length
  try {
    const run = (prompts: string[]) =>
      bridgeTurn(LAZY_SDK, {
        permissionMode: 'allow-all',
        env: claudeSettingsEnv(),
        home,
        mcpServers,
        prompts,
      })
    // No list kept yet: the server starts to give its list, which is kept.
    const first = await run(['look'])
    assert.deepEqual(first.record.filter((r) => r.what === 'tools')[0]?.names, ['navigate'])
    assert.equal(await started(), 1)
    // Then a session that never calls it lists its tools and starts nothing.
    const second = await run(['look', 'look again'])
    assert.deepEqual(second.record.filter((r) => r.what === 'tools')[0]?.names, ['navigate'])
    assert.equal(await started(), 1, 'the server did not start without a call')
    // Its first call starts it, and the call goes through.
    const third = await run(['call'])
    assert.deepEqual(
      third.record.filter((r) => r.what === 'result').map((r) => r.text),
      ['went'],
    )
    assert.equal(await started(), 2)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
