import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ApiToRunner } from '@brigade/contracts'
import { WebSocketServer } from 'ws'

// The runner reaches its workspace's hub (docs/workspace-hubs-plan.md): the API's welcome names
// the workspace, which the runner keeps in runner.json and names when it connects again; the
// answer to its keepalive, from a hub object that did not wake, is nothing to act on.
const home = await mkdtemp(join(tmpdir(), 'brigade-hub-connect-'))
process.env.BRIGADE_HOME = home
const { Outbox } = await import('../src/outbox.js')
const { Connection, RECONNECT_SPREAD_MS, reconnectDelay } = await import('../src/connection.js')

test.after(() => rm(home, { recursive: true, force: true }))

const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((r) => setTimeout(r, 10))
  assert.ok(check(), `timed out waiting for ${what}`)
}

test('the workspace the welcome names is kept, and named on the next connection', async () => {
  const server = new WebSocketServer({ port: 0 })
  await new Promise((resolve) => server.once('listening', resolve))
  const urls: string[] = []
  const sockets: import('ws').WebSocket[] = []
  server.on('connection', (ws, request) => {
    urls.push(request.url ?? '')
    sockets.push(ws)
    ws.on('message', (raw) => {
      if ((JSON.parse(String(raw)) as { type: string }).type !== 'hello') return
      ws.send(
        JSON.stringify({ type: 'welcome', runnerId: 'r', computerId: 'c', workspaceId: 'ws-1' }),
      )
      // As a hub object answers a keepalive, without waking.
      ws.send(JSON.stringify({ type: 'keepalive' }))
    })
  })
  const port = (server.address() as { port: number }).port
  const taken: ApiToRunner[] = []
  const config = {
    apiUrl: `http://127.0.0.1:${port}`,
    token: 'test',
    computerId: 'c',
    workspaceName: 'Test',
  }
  const connection = new Connection(
    config,
    new Outbox(join(home, 'outbox')),
    (message) => void taken.push(message),
    async () => ({}),
    () => false,
  )
  // Back at once: how long it waits is the next test's.
  connection.reconnectSpreadMs = 0
  connection.start()
  try {
    await until(() => taken.some((m) => m.type === 'welcome'), 'the welcome')
    assert.equal(urls[0], '/runner/ws', 'not known yet')
    await until(() => (config as { workspaceId?: string }).workspaceId === 'ws-1', 'kept')
    // Written apart from the welcome: once it is there.
    const saved = () => {
      try {
        return JSON.parse(readFileSync(join(home, 'runner.json'), 'utf8')) as {
          workspaceId?: string
          token?: string
        }
      } catch {
        return {}
      }
    }
    await until(() => saved().workspaceId === 'ws-1', 'runner.json written')
    assert.equal(saved().token, 'test')
    assert.ok(!taken.some((m) => m.type === 'keepalive'), 'the keepalive answer is not a command')

    // The connection drops: the next one names the workspace.
    sockets[0]!.terminate()
    await until(() => urls.length === 2, 'a new connection')
    assert.equal(urls[1], '/runner/ws?workspace=ws-1')
  } finally {
    connection.close()
    for (const ws of sockets) ws.terminate()
    server.close()
  }
})

test('runners dropped together come back spread over seconds, not in the same one', () => {
  // A deploy drops every runner at once: each waits its backoff and up to RECONNECT_SPREAD_MS more.
  assert.equal(
    reconnectDelay(1000, RECONNECT_SPREAD_MS, () => 0),
    1000,
  )
  assert.equal(
    reconnectDelay(1000, RECONNECT_SPREAD_MS, () => 0.999),
    1000 + Math.round(0.999 * RECONNECT_SPREAD_MS),
  )
  const delays = Array.from({ length: 200 }, () => reconnectDelay(1000))
  assert.ok(delays.every((d) => d >= 1000 && d <= 1000 + RECONNECT_SPREAD_MS))
  // Spread: not one second for all of them.
  const seconds = new Set(delays.map((d) => Math.floor(d / 1000)))
  assert.ok(seconds.size >= 5, `came back over ${seconds.size} distinct seconds`)
})

test('a call the API refused, or that never went, says so; one cut by a lost connection does not', async () => {
  const server = new WebSocketServer({ port: 0 })
  await new Promise((resolve) => server.once('listening', resolve))
  const sockets: import('ws').WebSocket[] = []
  let refuse = true
  server.on('connection', (ws) => {
    sockets.push(ws)
    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as { type: string; callId?: string }
      if (message.type === 'hello')
        ws.send(JSON.stringify({ type: 'welcome', runnerId: 'r', computerId: 'c' }))
      // The first call is refused; the second is under way when the connection drops.
      else if (message.type === 'library.call' && refuse) {
        refuse = false
        ws.send(
          JSON.stringify({
            type: 'connector.result',
            callId: message.callId,
            ok: false,
            error: 'This upload was used or refused; upload it again',
          }),
        )
      } else if (message.type === 'library.call') ws.terminate()
    })
  })
  const port = (server.address() as { port: number }).port
  const taken: ApiToRunner[] = []
  const connection = new Connection(
    { apiUrl: `http://127.0.0.1:${port}`, token: 'test', computerId: 'c', workspaceName: 'Test' },
    new Outbox(join(home, 'outbox-calls')),
    (message) => void taken.push(message),
    async () => ({}),
    () => false,
  )
  const call = () =>
    connection.callLibrary({
      sessionId: 's',
      teammateId: 't',
      operation: { name: 'save', path: 'X/a.txt', upload: { id: 'u1' } },
    })
  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => assert.fail('it succeeded'),
      (error: Error & { answered?: boolean }) => error,
    )
  try {
    // Not connected yet: it never went.
    assert.equal((await failure(call())).answered, true)
    connection.start()
    await until(() => taken.some((m) => m.type === 'welcome'), 'the welcome')
    const refused = await failure(call())
    assert.equal(refused.message, 'This upload was used or refused; upload it again')
    assert.equal(refused.answered, true)
    // Under way when the connection is lost: it may have been made.
    const cut = await failure(call())
    assert.match(cut.message, /Lost the connection to Brigade/)
    assert.equal(cut.answered, undefined)
  } finally {
    connection.close()
    for (const ws of sockets) ws.terminate()
    server.close()
  }
})
