import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { jsonSchema, tool, type ToolSet } from 'ai'
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

async function turn(calls: [string, unknown][], options: { home?: string; tools?: ToolSet } = {}) {
  ran.length = 0
  const { record } = await bridgeTurn(TOOLS_SDK, {
    permissionMode: 'allow-all',
    env: { FAKE_CALLS: JSON.stringify(calls) },
    tools: options.tools ?? tools,
    toolHints: { look_up: { readOnly: true, alwaysLoad: true } },
    ...(options.home ? { home: options.home } : {}),
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

// The converted schemas a turn keeps for the next ones, in the home: converting a teammate's
// App tools takes about 300 MB at each turn's start.
const schemasDir = (home: string) => join(home, '.ai-sdk-harness', '.tool-schemas')
type Schemas = Record<string, { d: number; s: Record<string, unknown> }>
async function schemasFile(home: string) {
  const names = (await readdir(schemasDir(home))).filter((name) => name.endsWith('.json'))
  assert.equal(names.length, 1)
  return join(schemasDir(home), names[0]!)
}
const readSchemas = async (file: string) => JSON.parse(await readFile(file, 'utf8')) as Schemas
const today = () => Math.floor(Date.now() / 86_400_000)
const listedSchemas = (listed: { name: string; inputSchema?: unknown }[]) =>
  Object.fromEntries(listed.map((t) => [t.name, t.inputSchema]))

async function withHome(run: (home: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), 'claude-bridge-home-'))
  try {
    await run(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

test("a later turn reads its tools' converted schemas from the first one's file", async () => {
  await withHome(async (home) => {
    const first = await turn([], { home })
    const file = await schemasFile(home)
    const kept = await readSchemas(file)
    // One entry per schema, as the turn listed it, used today.
    assert.deepEqual(
      Object.values(kept)
        .map((entry) => entry.s)
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      Object.values(listedSchemas(first.tools)).sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      ),
    )
    for (const entry of Object.values(kept)) assert.equal(entry.d, today())

    // What the next turn lists comes from the file: marked there, the mark shows.
    for (const entry of Object.values(kept)) entry.s.description = 'from the file'
    await writeFile(file, JSON.stringify(kept))
    const second = await turn([['look_up', { query: 'boats' }]], { home })
    for (const t of second.tools)
      assert.equal((t.inputSchema as { description?: string }).description, 'from the file')
    assert.deepEqual(second.hidden, { look_up: [], save_note: [] })
    // A call is still checked against the tool's own schema, and runs.
    assert.deepEqual(ran, [{ query: 'boats' }])

    // A tool whose schema changed is converted again; the others still come from the file.
    const changed = {
      ...tools,
      save_note: tool({
        description: 'Save a note',
        inputSchema: jsonSchema({
          type: 'object',
          properties: { text: { type: 'string' }, pinned: { type: 'boolean' } },
          required: ['text'],
        }),
        execute: async () => ({ saved: true }),
      }),
    }
    const third = await turn([], { home, tools: changed })
    const schemas = listedSchemas(third.tools) as Record<string, { description?: string }>
    assert.equal(schemas.look_up!.description, 'from the file')
    assert.deepEqual(schemas.save_note, {
      type: 'object',
      properties: { text: { type: 'string' }, pinned: { type: 'boolean' } },
      required: ['text'],
      $schema: 'http://json-schema.org/draft-07/schema#',
      additionalProperties: {},
    })
    assert.equal(Object.keys(await readSchemas(file)).length, 3)
  })
})

test('a broken schemas file only means converting again, and is written anew', async () => {
  await withHome(async (home) => {
    const fresh = await turn([])
    await turn([], { home })
    const file = await schemasFile(home)
    // Entries of the tools' own schemas, broken.
    const kept = await readSchemas(file)
    const brokenEntries = Object.fromEntries(
      Object.keys(kept).map((key) => [key, { d: today(), s: 5 }]),
    )
    for (const broken of ['{"not json', '[1, 2]', JSON.stringify(brokenEntries)]) {
      await writeFile(file, broken)
      const again = await turn([], { home })
      assert.deepEqual(again.tools, fresh.tools)
      const kept = await readSchemas(file)
      assert.equal(Object.keys(kept).length, 2)
      assert.ok(Object.values(kept).every((entry) => typeof entry.s === 'object'))
    }
  })
})

test('schemas no turn used for 30 days, and old files of other bridge versions, go', async () => {
  await withHome(async (home) => {
    await turn([], { home })
    const file = await schemasFile(home)
    const kept = await readSchemas(file)
    const [first] = Object.keys(kept)
    // Last used 31 days ago (still listed this turn: used again), and two others nobody uses.
    kept[first!]!.d = today() - 31
    kept.unused = { d: today() - 31, s: { type: 'object' } }
    kept.recent = { d: today() - 30, s: { type: 'object' } }
    await writeFile(file, JSON.stringify(kept))
    const old = join(schemasDir(home), '0000000000000000.json')
    const recent = join(schemasDir(home), '1111111111111111.json')
    await mkdir(schemasDir(home), { recursive: true })
    await writeFile(old, '{}')
    await writeFile(recent, '{}')
    const fourDaysAgo = new Date(Date.now() - 4 * 86_400_000)
    await utimes(old, fourDaysAgo, fourDaysAgo)

    await turn([], { home })
    const after = await readSchemas(file)
    assert.equal(after[first!]!.d, today())
    assert.equal(after.unused, undefined)
    assert.ok(after.recent)
    assert.deepEqual(
      (await readdir(schemasDir(home))).sort(),
      ['1111111111111111.json', file.split('/').pop()].sort(),
    )
  })
})

test("another dependency lock means converting again, in a file of the new bridge's own", async () => {
  await withHome(async (home) => {
    await turn([], { home })
    const before = await schemasFile(home)
    const kept = await readSchemas(before)
    for (const entry of Object.values(kept)) entry.s.description = 'from the file'
    await writeFile(before, JSON.stringify(kept))
    // The lock the bootstrap installed beside the bridge, as an update of its dependencies leaves it.
    const lock = join(
      home,
      '.ai-sdk-harness',
      '.harness-bootstrap',
      'claude-code',
      'pnpm-lock.yaml',
    )
    assert.ok((await stat(lock)).size > 0)
    await appendFile(lock, '\n# another version of the converter\n')

    const after = await turn([], { home })
    for (const t of after.tools)
      assert.equal((t.inputSchema as { description?: string }).description, undefined)
    const names = (await readdir(schemasDir(home))).filter((name) => name.endsWith('.json'))
    assert.equal(names.length, 2)
  })
})
