import assert from 'node:assert/strict'
import { test } from 'node:test'
import { jsonSchema, tool } from 'ai'
import { bridgeTurn } from './fixtures/claude-bridge.js'

// Brigade's tools as the Claude Code bridge (patched) serves them to Claude Code: listed from
// their JSON, with no zod schema kept for the turn (883 App tools held about 600 MB in each
// turn's bridge), each call's input still checked against the tool's schema.

/**
 * Claude Code connecting to the bridge's tool server, listing its tools and calling them
 * (FAKE_CALLS): it writes down the list, which hidden properties each schema carries, and
 * each call's result.
 */
const TOOLS_SDK = `import { appendFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
export function query({ prompt, options }) {
  async function* run() {
    const first = await prompt[Symbol.asyncIterator]().next()
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'claude-code', version: '0' })
    await Promise.all([options.mcpServers['harness-tools'].instance.connect(serverSide), client.connect(clientSide)])
    const { tools } = await client.listTools()
    // What the server keeps for its list, as it keeps it: a client parses the list into copies.
    const instance = options.mcpServers['harness-tools'].instance
    const list = (instance.server ?? instance)._requestHandlers.get('tools/list')
    const kept = (await list({ method: 'tools/list', params: {} }, {})).tools
    const hidden = Object.fromEntries(kept.map((t) => [t.name, Object.getOwnPropertyNames(t.inputSchema).filter((key) => !Object.keys(t.inputSchema).includes(key))]))
    const results = []
    for (const [name, args] of JSON.parse(process.env.FAKE_CALLS)) results.push(await client.callTool({ name, arguments: args }))
    appendFileSync(process.env.FAKE_SDK_RECORD, JSON.stringify({ tools, hidden, results }) + '\\n')
    yield { type: 'system', subtype: 'init', session_id: 'fake-session' }
    yield { type: 'result', subtype: 'success', is_error: false, result: 'done', user_message_uuid: first.value.uuid, session_id: 'fake-session', usage: { input_tokens: 1, output_tokens: 1 } }
  }
  const messages = run()
  messages.interrupt = async () => {}
  return messages
}
`

const ran: unknown[] = []
const tools = {
  look_up: tool({
    description: 'Look something up',
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for' },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
      required: ['query'],
      additionalProperties: false,
    }),
    execute: async (input) => {
      ran.push(input)
      return { found: 'it' }
    },
  }),
  save_note: tool({
    description: 'Save a note',
    inputSchema: jsonSchema({
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    }),
    execute: async () => ({ saved: true }),
  }),
}

async function turn(calls: [string, unknown][]) {
  ran.length = 0
  const { record } = await bridgeTurn(TOOLS_SDK, {
    permissionMode: 'allow-all',
    env: { FAKE_CALLS: JSON.stringify(calls) },
    tools,
    toolHints: { look_up: { readOnly: true, alwaysLoad: true } },
  })
  return record[0] as {
    tools: { name: string; [key: string]: unknown }[]
    hidden: Record<string, string[]>
    results: { content: { type: string; text: string }[]; isError?: boolean }[]
  }
}

test("Claude Code gets Brigade's tools as McpServer listed them, with their hints", async () => {
  const { tools: listed } = await turn([])
  assert.deepEqual(listed, [
    {
      name: 'look_up',
      description: 'Look something up',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to look for' },
          limit: { type: 'integer', minimum: 1, maximum: 20 },
        },
        required: ['query'],
        $schema: 'http://json-schema.org/draft-07/schema#',
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execution: { taskSupport: 'forbidden' },
      _meta: { 'anthropic/alwaysLoad': true },
    },
    {
      name: 'save_note',
      description: 'Save a note',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        $schema: 'http://json-schema.org/draft-07/schema#',
        additionalProperties: {},
      },
      execution: { taskSupport: 'forbidden' },
    },
  ])
})

test('the listed schemas are plain JSON: no zod schema stays behind them', async () => {
  // zod's JSON Schema conversion leaves a hidden `~standard` on its result, which holds the
  // zod schema: kept for a turn, a thread's App tools held about 600 MB.
  const { hidden } = await turn([])
  assert.deepEqual(hidden, { look_up: [], save_note: [] })
})

test("a call's input is still checked against its tool's schema", async () => {
  const { results } = await turn([
    ['look_up', { query: 5 }],
    ['look_up', { query: 'a', extra: 1 }],
    ['nope', {}],
  ])
  assert.deepEqual(results, [
    {
      content: [
        {
          type: 'text',
          text: 'MCP error -32602: Input validation error: Invalid arguments for tool look_up: Invalid input: expected string, received number at query',
        },
      ],
      isError: true,
    },
    {
      content: [
        {
          type: 'text',
          text: 'MCP error -32602: Input validation error: Invalid arguments for tool look_up: Unrecognized key: "extra"',
        },
      ],
      isError: true,
    },
    { content: [{ type: 'text', text: 'MCP error -32602: Tool nope not found' }], isError: true },
  ])
  // A refused call never reaches the tool.
  assert.deepEqual(ran, [])
})

test('a valid call runs the tool and gives Claude Code its result', async () => {
  const { results } = await turn([
    ['look_up', { query: 'boats', limit: 3 }],
    ['look_up', { query: 'again' }],
  ])
  assert.deepEqual(ran, [{ query: 'boats', limit: 3 }, { query: 'again' }])
  assert.equal(results.length, 2)
  for (const result of results) {
    assert.notEqual(result.isError, true)
    assert.match(result.content[0]!.text, /found/)
  }
})
