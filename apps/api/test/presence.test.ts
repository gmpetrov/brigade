import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

// hub.ts reads the API's config when imported; nothing here reaches a database or the vault.
process.env.DATABASE_URL ??= 'postgresql://test@localhost/test'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
const { browserSocket, isLooking } = await import('../src/hub.js')

const scope = (memberId: string) => ({
  organizationId: 'org',
  workspaceId: 'ws',
  userId: `user-${memberId}`,
  memberId,
  role: 'member' as const,
})
const ws = { send() {}, close() {} } as never
const say = (socket: ReturnType<typeof browserSocket>, visible: boolean) =>
  socket.onMessage(JSON.stringify({ type: 'presence', visible }), ws)

test('a socket that never says it is in view does not count as looking', () => {
  // A thread's events or a terminal: their sockets send no presence.
  const socket = browserSocket(scope('silent'))
  socket.onOpen(ws)
  assert.equal(isLooking('silent', 120_000), false)
  socket.onClose()
})

test('in view while it says so, then for a while after it leaves', async () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  try {
    const socket = browserSocket(scope('ada'))
    socket.onOpen(ws)
    await say(socket, true)
    assert.equal(isLooking('ada', 120_000), true)
    await say(socket, false)
    assert.equal(isLooking('ada', 120_000), true, 'just left: still counts')
    mock.timers.tick(121_000)
    assert.equal(isLooking('ada', 120_000), false)
    socket.onClose()
  } finally {
    mock.timers.reset()
  }
})

test('a phone that suspends the app without a word stops counting once its presence runs out', async () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  try {
    const socket = browserSocket(scope('bob'))
    socket.onOpen(ws)
    await say(socket, true)
    // The app went to the background; its socket stays open and says nothing more.
    mock.timers.tick(60_000)
    assert.equal(isLooking('bob', 0), true)
    mock.timers.tick(20_000)
    assert.equal(isLooking('bob', 0), false)
    socket.onClose()
  } finally {
    mock.timers.reset()
  }
})
