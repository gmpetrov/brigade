import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConnectorGrant } from '@brigade/contracts'
import { connectorTools, type ConnectorCaller } from '../src/harness/tools.js'

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
