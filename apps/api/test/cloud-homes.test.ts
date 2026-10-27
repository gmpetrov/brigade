import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

// cloud.ts reads the API's config and its provider when imported; boat's API is stubbed below,
// and nothing reaches a database.
process.env.DATABASE_URL ??= 'postgresql://test@localhost/test'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
process.env.BOAT_API_KEY = 'test'
const { BoatApi } = createRequire(
  new URL('../../../packages/providers/package.json', import.meta.url),
)('@boatdev/sdk') as typeof import('@boatdev/sdk')

type Sandbox = { state: string; hydrated?: boolean; hydratedAt?: Date }
/** What GET /sandboxes/{id} answers, in turn: a promise is answered once it settles. */
let answers: (Sandbox | Promise<Sandbox>)[] = []
let checks = 0
let commands = 0
Object.assign(BoatApi.prototype, {
  get: async () => ({ sandbox: await answers[Math.min(checks++, answers.length - 1)] }),
  command: async () => {
    commands++
    return { exitCode: 0, stdout: '', stderr: '' }
  },
})
const cloud = await import('../src/cloud.js')
const { inWorkspaceHub } = await import('./in-hub.js')
/** The check runs in the computer's workspace hub, on its runner's hello. */
const giveHomesBackOnceRestored = (computer: { id: string; providerRef: unknown }) =>
  inWorkspaceHub('ws', () => cloud.giveHomesBackOnceRestored(computer))

const restoredAt = (at: string): Sandbox => ({
  state: 'ready',
  hydrated: true,
  hydratedAt: new Date(at),
})

test('homes are given back once per restore', async () => {
  const computer = { id: 'once', providerRef: { provider: 'boat', id: 'sandbox-once' } }
  answers = [restoredAt('2026-10-21T01:52:00Z')]
  checks = commands = 0
  await giveHomesBackOnceRestored(computer)
  assert.equal(commands, 1)
  // The runner restarting (an update): the same restore.
  await giveHomesBackOnceRestored(computer)
  assert.equal(commands, 1)
  // The next resume's.
  answers = [restoredAt('2026-10-21T09:00:00Z')]
  await giveHomesBackOnceRestored(computer)
  assert.equal(commands, 2)
})

test('a hello while an earlier check is unanswered has its own restore checked', async () => {
  const computer = { id: 'again', providerRef: { provider: 'boat', id: 'sandbox-again' } }
  let stopped!: (sandbox: Sandbox) => void
  // Asked before the computer stopped, answered once it has resumed: the old boot's state.
  answers = [
    new Promise<Sandbox>((resolve) => (stopped = resolve)),
    restoredAt('2026-10-21T03:00:00Z'),
  ]
  checks = commands = 0
  const earlier = giveHomesBackOnceRestored(computer)
  // The resumed computer's runner says hello meanwhile.
  await giveHomesBackOnceRestored(computer)
  stopped({ state: 'archived', hydrated: false })
  await earlier
  for (let i = 0; i < 10 && commands === 0; i++) await new Promise(setImmediate)
  assert.equal(checks, 2)
  assert.equal(commands, 1)
})
