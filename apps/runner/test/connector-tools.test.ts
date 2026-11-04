import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConnectorGrant } from '@brigade/contracts'
import { CATALOG_TOOL, connectorTools, type ConnectorCaller } from '../src/harness/tools.js'

// An App's tools when a thread has several of its accounts: one tool per operation, with an
// `account` parameter, rather than one per operation and account.

const big = {
  type: 'object',
  properties: { query: { type: 'string' }, filters: { type: 'array', items: { type: 'object' } } },
  required: ['query'],
} as const

const grant = (
  connectionId: string,
  account: string,
  operations: { name: string; write: boolean; inputSchema?: unknown }[],
): ConnectorGrant =>
  ({
    connectionId,
    kind: 'posthog',
    label: 'PostHog',
    externalAccount: account,
    scope: 'write',
    operations: operations.map((o) => ({
      description: `Do ${o.name}`,
      inputSchema: big,
      ...o,
    })),
  }) as unknown as ConnectorGrant

const schemaOf = (t: unknown) => (t as { inputSchema: { jsonSchema: any } }).inputSchema.jsonSchema
const run = (t: unknown, input: unknown) =>
  (t as { execute: (input: unknown, o: { toolCallId: string }) => Promise<unknown> }).execute(
    input,
    { toolCallId: 'call-1' },
  )

test("an App's accounts share one tool per operation, the account a parameter", async () => {
  const calls: Parameters<ConnectorCaller>[0][] = []
  const tools = connectorTools(
    [
      grant('c1', 'Brigade', [
        { name: 'posthog_query', write: false },
        { name: 'posthog_flag_update', write: true },
      ]),
      // Read-only: no writes.
      grant('c2', 'NoCo AI', [{ name: 'posthog_query', write: false }]),
    ],
    async (call) => {
      calls.push(call)
      return 'ok'
    },
  )
  assert.deepEqual(Object.keys(tools).sort(), ['posthog_flag_update', 'posthog_query'])
  const query = schemaOf(tools.posthog_query)
  assert.deepEqual(query.properties.account.enum, ['Brigade', 'NoCo AI'])
  assert.deepEqual(query.required, ['account', 'query'])
  assert.deepEqual(query.properties.filters, big.properties.filters)
  // Only the account whose grant has the operation.
  assert.deepEqual(schemaOf(tools.posthog_flag_update).properties.account.enum, ['Brigade'])
  assert.match((tools.posthog_query as { description: string }).description, /Brigade, NoCo AI/)
  // A call goes to its account's connection, without the parameter.
  await run(tools.posthog_query, { account: 'NoCo AI', query: 'q' })
  assert.deepEqual(
    calls.map((c) => [c.connectionId, c.operation, c.input, c.toolName]),
    [['c2', 'posthog_query', { query: 'q' }, 'posthog_query']],
  )
  await assert.rejects(run(tools.posthog_flag_update, { account: 'NoCo AI' }), /use one of Brigade/)
  assert.equal(calls.length, 1)
})

test('an operation whose schemas differ, or that takes an account of its own, keeps a tool per account', () => {
  const own = { type: 'object', properties: { account: { type: 'string' } } }
  const tools = connectorTools(
    [
      grant('c1', 'Brigade', [
        { name: 'posthog_query', write: false },
        { name: 'posthog_switch', write: false, inputSchema: own },
      ]),
      grant('c2', 'NoCo AI', [
        { name: 'posthog_query', write: false, inputSchema: { type: 'object', properties: {} } },
        { name: 'posthog_switch', write: false, inputSchema: own },
      ]),
    ],
    async () => 'ok',
  )
  assert.deepEqual(Object.keys(tools).sort(), [
    'posthog_query_brigade',
    'posthog_query_noco_ai',
    'posthog_switch_brigade',
    'posthog_switch_noco_ai',
  ])
})

test('one account: the tools as before, no parameter', () => {
  const tools = connectorTools(
    [grant('c1', 'Brigade', [{ name: 'posthog_query', write: false }])],
    async () => 'ok',
  )
  assert.deepEqual(Object.keys(tools), ['posthog_query'])
  assert.equal(schemaOf(tools.posthog_query).properties.account, undefined)
  assert.match((tools.posthog_query as { description: string }).description, /\[PostHog: Brigade\]/)
})

test('a big App goes behind a catalog: find, describe, run, on the account asked', async () => {
  const calls: Parameters<ConnectorCaller>[0][] = []
  const heavy = (n: number) => ({
    type: 'object',
    properties: { query: { type: 'string', description: 'x'.repeat(n) } },
  })
  const ops = [
    { name: 'posthog_query-trends', write: false, inputSchema: heavy(200_000) },
    { name: 'posthog_feature-flag-update', write: true, inputSchema: heavy(150_000) },
    { name: 'posthog_insight-get', write: false, inputSchema: heavy(10) },
  ]
  const tools = connectorTools(
    [
      grant('c1', 'Brigade', ops),
      grant(
        'c2',
        'NoCo AI',
        ops.filter((o) => !o.write),
      ),
    ],
    async (call) => {
      calls.push(call)
      return 'ok'
    },
  )
  assert.deepEqual(Object.keys(tools).sort(), ['posthog_describe', 'posthog_find', 'posthog_run'])
  for (const t of Object.values(tools))
    assert.ok((t as unknown as Record<symbol, unknown>)[CATALOG_TOOL], 'always loaded')
  const found = (await run(tools.posthog_find, { query: 'insight' })) as { operations: any[] }
  assert.equal(found.operations[0].operation, 'posthog_insight-get')
  assert.ok(found.operations[0].inputSchema, 'a small schema comes with it')
  // A schema past what a search returns whole: described on its own.
  const trends = (await run(tools.posthog_find, { query: 'trends' })) as { operations: any[] }
  assert.equal(trends.operations[0].inputSchema, undefined)
  const described = (await run(tools.posthog_describe, {
    operation: 'posthog_query-trends',
  })) as any
  assert.equal(described.inputSchema.properties.query.description.length, 200_000)
  await run(tools.posthog_run, {
    operation: 'posthog_insight-get',
    account: 'NoCo AI',
    input: { query: 'q' },
  })
  assert.deepEqual(
    calls.map((c) => [c.connectionId, c.operation, c.input]),
    [['c2', 'posthog_insight-get', { query: 'q' }]],
  )
  // A write the read-only account lacks.
  await assert.rejects(
    run(tools.posthog_run, {
      operation: 'posthog_feature-flag-update',
      account: 'NoCo AI',
      input: {},
    }),
    /use one of Brigade/,
  )
})
