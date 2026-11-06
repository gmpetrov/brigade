import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ThreadSpec } from '@brigade/contracts'
import { agentKey } from '../src/harness/index.js'

// A live session is made anew when its agent's key changes (HarnessThread.run parks it): its
// tools, and its instructions, written only as a session starts. Whether an account can be used
// is in those instructions ("Accounts you cannot use now"), so it is in the key, even where the
// account's tools stay the same.
const grant = (extra: Record<string, unknown> = {}) => ({
  connectionId: 'c1',
  kind: 'openrouter',
  label: 'OpenRouter',
  externalAccount: 'Personal account',
  scope: 'read_write',
  operations: [],
  ...extra,
})
const key = (...connectors: ReturnType<typeof grant>[]) =>
  agentKey({ connectors, effort: null } as unknown as ThreadSpec)

test("an account's availability changing makes the session anew, its tools the same", () => {
  // An MCP server down one turn, refusing the account the next: no tools either way.
  assert.notEqual(
    key(grant({ unavailable: 'unreachable' })),
    key(grant({ unavailable: 'signed_out' })),
  )
  // Brigade's own connector, its tools listed whatever its state: reconnected.
  const gmail = grant({ kind: 'gmail', operations: [{ name: 'gmail_search' }] })
  assert.notEqual(key({ ...gmail, unavailable: 'signed_out' }), key(gmail))
  // A usable account's key is as it was before availability: a runner update parks nothing.
  assert.equal(key(grant()), JSON.stringify([null, [['c1', 'read_write', []]], undefined]))
})

test('a machine of its own for the thread makes the session anew; none keeps the key as before', () => {
  const spec = (machine?: boolean) =>
    agentKey({
      connectors: [],
      effort: null,
      ...(machine ? { machine } : {}),
    } as unknown as ThreadSpec)
  // Its tools (run_on_machine, machine_run) and its instructions come with it.
  assert.notEqual(spec(true), spec(false))
  assert.equal(spec(false), JSON.stringify([null, [], undefined]))
})
