import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
const { Connection } = await import('../src/connection.js')

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
  connection.start()
  await until(() => taken.some((m) => m.type === 'welcome'), 'the welcome')
  assert.equal(urls[0], '/runner/ws', 'not known yet')
  await until(() => (config as { workspaceId?: string }).workspaceId === 'ws-1', 'kept')
  const saved = JSON.parse(await readFile(join(home, 'runner.json'), 'utf8')) as {
    workspaceId?: string
    token?: string
  }
  assert.equal(saved.workspaceId, 'ws-1')
  assert.equal(saved.token, 'test')
  assert.ok(!taken.some((m) => m.type === 'keepalive'), 'the keepalive answer is not a command')

  // The connection drops: the next one names the workspace.
  sockets[0]!.terminate()
  await until(() => urls.length === 2, 'a new connection')
  assert.equal(urls[1], '/runner/ws?workspace=ws-1')
  connection.close()
  for (const ws of sockets) ws.terminate()
  server.close()
})
