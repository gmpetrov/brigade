import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConnectorGrant } from '@brigade/contracts'
import { CATALOG_TOOL, connectorTools, type ConnectorCaller } from '../src/harness/tools.js'

// An App's tools: one per operation, or, for a big App, a catalog of three (find, describe, run).

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

test('an App that is not big: a tool per operation', () => {
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

test('a catalogued operation whose schema differs by account is described and run as that account has it', async () => {
  const calls: Parameters<ConnectorCaller>[0][] = []
  const pad = 'x'.repeat(310_000)
  const tools = connectorTools(
    [
      grant('c1', 'A', [
        {
          name: 'example_search',
          write: false,
          inputSchema: {
            type: 'object',
            description: pad,
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
      ]),
      grant('c2', 'B', [
        {
          name: 'example_search',
          write: false,
          inputSchema: {
            type: 'object',
            properties: { project: { type: 'string' } },
            required: ['project'],
          },
        },
      ]),
    ],
    async (call) => {
      calls.push(call)
      return 'ok'
    },
  )
  assert.deepEqual(Object.keys(tools).sort(), ['posthog_describe', 'posthog_find', 'posthog_run'])
  const b = (await run(tools.posthog_describe, {
    operation: 'example_search',
    account: 'B',
  })) as any
  assert.deepEqual(b.inputSchema.required, ['project'])
  assert.deepEqual(b.accounts, ['B'])
  // Without an account, an operation its accounts have differently is not described as either's.
  await assert.rejects(
    run(tools.posthog_describe, { operation: 'example_search' }),
    /use one of A, B/,
  )
  const a = (await run(tools.posthog_describe, {
    operation: 'example_search',
    account: 'A',
  })) as any
  assert.deepEqual(a.inputSchema.required, ['query'])
  // Found once per variant, each with the accounts that have it.
  const found = (await run(tools.posthog_find, { query: 'search' })) as { operations: any[] }
  assert.deepEqual(found.operations.map((o) => o.accounts).sort(), [['A'], ['B']])
  await run(tools.posthog_run, {
    operation: 'example_search',
    account: 'B',
    input: { project: 'p' },
  })
  assert.deepEqual(
    calls.map((c) => c.connectionId),
    ['c2'],
  )
})
