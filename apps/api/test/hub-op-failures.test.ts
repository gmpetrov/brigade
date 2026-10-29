import assert from 'node:assert/strict'
import { test } from 'node:test'

// An operation asked of a workspace's hub from another object (outcomeHere, src/hub.ts) that
// throws: its caller gets a line naming the operation and the error, even one without a message
// (as when a hub object is reset mid-operation), and it is counted for the hub-op alert. A
// refusal (HTTPException) crosses as it is, uncounted. No database.
process.env.DATABASE_URL ??= 'postgresql://test@127.0.0.1:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
const { HTTPException } = await import('hono/http-exception')
const { outcomeHere, valueOf, describeError } = await import('../src/hub.js')
const { localHub } = await import('../src/hub/memory-host.js')
const { failuresOf } = await import('../src/ops/failures.js')

const workspaceId = `ws-hub-op-${Date.now()}`
const hub = localHub(workspaceId)
const errors: unknown[][] = []
const consoleError = console.error
console.error = (...args: unknown[]) => void errors.push(args)
test.after(() => (console.error = consoleError))

test('an error without a message still says what failed, and is counted', async () => {
  hub.isOnline = () => {
    throw new Error('')
  }
  const outcome = await outcomeHere(workspaceId, 'isOnline', ['computer-1'])
  assert.equal(outcome.ok, false)
  assert.throws(() => valueOf(outcome), {
    message: 'isOnline failed in the hub: Error: (no message)',
  })
  const counted = failuresOf('hub-op', 60_000).filter((f) => f.workspaceId === workspaceId)
  assert.deepEqual(
    counted.map((f) => f.message),
    ['isOnline: Error: (no message)'],
  )
  assert.match(String(errors.at(-1)?.[0]), new RegExp(`hub ${workspaceId}: isOnline failed`))
})

test('a refusal crosses with its status, uncounted', async () => {
  hub.isOnline = () => {
    throw new HTTPException(409, { message: 'That computer is offline' })
  }
  const before = failuresOf('hub-op', 60_000).length
  const outcome = await outcomeHere(workspaceId, 'isOnline', ['computer-1'])
  assert.throws(
    () => valueOf(outcome),
    (error: unknown) => {
      assert.ok(error instanceof HTTPException)
      assert.equal(error.status, 409)
      assert.equal(error.message, 'That computer is offline')
      return true
    },
  )
  assert.equal(failuresOf('hub-op', 60_000).length, before)
})

test('what was thrown, said in a line', () => {
  assert.equal(describeError(new TypeError('x is undefined')), 'TypeError: x is undefined')
  assert.equal(describeError(undefined), 'thrown undefined: undefined')
  assert.equal(describeError('gone'), 'thrown string: gone')
})
