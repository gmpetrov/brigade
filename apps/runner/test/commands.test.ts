import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { OUTBOX_PROTOCOL, type ApiToRunner, type RunnerToApi } from '@brigade/contracts'
import { WebSocketServer, type WebSocket } from 'ws'

// Commands from the API, acknowledged by id (OUTBOX_PROTOCOL): one sent again is acknowledged and
// ignored, also by a runner that restarted in between; and a call that waited on a person when
// the connection dropped tells the teammate it still waits, not to try again.
const home = await mkdtemp(join(tmpdir(), 'brigade-commands-'))
process.env.BRIGADE_HOME = home
const { Outbox } = await import('../src/outbox.js')
const { Connection, STILL_WAITING } = await import('../src/connection.js')
const { SeenCommands } = await import('../src/seen-commands.js')

test.after(() => rm(home, { recursive: true, force: true }))

/** An API on a local port: what runners say to it, and their sockets. */
async function api() {
  const server = new WebSocketServer({ port: 0 })
  await new Promise((resolve) => server.once('listening', resolve))
  const heard: RunnerToApi[] = []
  const sockets: WebSocket[] = []
  server.on('connection', (ws) => {
    sockets.push(ws)
    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as RunnerToApi
      heard.push(message)
      if (message.type === 'hello')
        ws.send(JSON.stringify({ type: 'welcome', runnerId: 'r', computerId: 'c' }))
    })
  })
  const port = (server.address() as { port: number }).port
  return { server, heard, sockets, url: `http://127.0.0.1:${port}` }
}

const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10))
  assert.ok(check(), `timed out waiting for ${what}`)
}

function runner(url: string, seenFile: string, taken: ApiToRunner[]) {
  const connection = new Connection(
    { apiUrl: url, token: 'test', workspaceName: 'Test' } as never,
    new Outbox(join(home, `outbox-${Math.random()}`)),
    (message) => taken.push(message),
    async () => ({}),
    () => false,
    new SeenCommands(seenFile),
  )
  connection.start()
  return connection
}

const command = {
  type: 'thread.interrupt',
  commandId: 'cmd-1',
  sessionId: 's-1',
} as const

test('a command sent again is acknowledged and ignored, even after the runner restarted', async () => {
  const { server, heard, sockets, url } = await api()
  const seen = join(home, 'seen.json')
  const taken: ApiToRunner[] = []
  const first = runner(url, seen, taken)
  await until(() => heard.some((m) => m.type === 'hello'), 'hello')
  const hello = heard.find((m) => m.type === 'hello') as { protocolVersion: number }
  assert.equal(hello.protocolVersion >= OUTBOX_PROTOCOL, true)
  await until(() => taken.some((m) => m.type === 'welcome'), 'welcome')
  sockets[0]!.send(JSON.stringify(command))
  sockets[0]!.send(JSON.stringify(command))
  const acks = () => heard.filter((m) => m.type === 'command.ack')
  await until(() => acks().length === 2, 'two acks')
  assert.deepEqual(acks()[0], { type: 'command.ack', commandIds: ['cmd-1'] })
  assert.equal(taken.filter((m) => m.type === 'thread.interrupt').length, 1, 'taken once')
  first.close()

  // The runner restarts; the API had not seen the ack, and sends it again on hello.
  const after: ApiToRunner[] = []
  const second = runner(url, seen, after)
  await until(() => sockets.length === 2, 'the second connection')
  await until(() => after.some((m) => m.type === 'welcome'), 'welcome')
  sockets[1]!.send(JSON.stringify(command))
  await until(() => acks().length === 3, 'the ack')
  assert.equal(after.filter((m) => m.type === 'thread.interrupt').length, 0, 'ignored')
  second.close()
  server.close()
})

test('a call that waits on a person when the connection drops says it still waits', async () => {
  const { server, heard, sockets, url } = await api()
  const connection = runner(url, join(home, 'seen-2.json'), [])
  await until(() => heard.some((m) => m.type === 'hello'), 'hello')
  await new Promise((r) => setTimeout(r, 50))
  const pending: string[] = []
  const hooks = { onPending: (ticketId: string) => pending.push(ticketId), onDecision: () => {} }
  const waiting = connection.callConnector(
    { sessionId: 's', connectionId: 'c', operation: 'gmail_send', input: {} },
    hooks,
  )
  const plain = connection.callConnector(
    { sessionId: 's', connectionId: 'c', operation: 'gmail_read', input: {} },
    hooks,
  )
  await until(() => heard.filter((m) => m.type === 'connector.call').length === 2, 'the calls')
  const call = heard.find((m) => m.type === 'connector.call') as { callId: string }
  sockets[0]!.send(
    JSON.stringify({
      type: 'connector.pending',
      callId: call.callId,
      ticketId: 't-1',
      target: 'x',
    }),
  )
  await until(() => pending.length === 1, 'pending')
  sockets[0]!.terminate()
  await assert.rejects(waiting, { message: STILL_WAITING })
  await assert.rejects(plain, {
    message: /Lost the connection to Brigade during this call; try again/,
  })
  connection.close()
  server.close()
})
