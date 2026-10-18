// preview_logs gives a running preview's address, so a teammate tests on the
// thread's preview rather than starting a copy of its own.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const home = await mkdtemp(join(tmpdir(), 'brigade-preview-logs-'))
process.env.BRIGADE_HOME = home
delete process.env.BRIGADE_CLOUD
const { Previews } = await import('../src/previews.js')

test.after(() => rm(home, { recursive: true, force: true }))

/** A port nothing listens on. */
async function freePort() {
  const server = createServer()
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as { port: number }
  await new Promise((done) => server.close(done))
  return port
}

const work = join(home, 'teammates', 'tm1', 'threads', 's1')
await mkdir(work, { recursive: true })
const seat = { sessionId: 's1', teammateId: 'tm1', workDir: work }
const control = new Previews({
  emit: () => undefined,
  expose: null,
  viewUrl: null,
  recipes: async () => ({ recipe: null }),
  seat: () => seat,
  stateFile: join(home, 'state', 'previews.json'),
}).forSeat(seat)

test('a running preview’s logs give its address; none without one', async () => {
  assert.deepEqual(control.logs(), { status: 'none', logs: '' })

  const port = await freePort()
  const script = `require('http').createServer((q, s) => s.end('hi')).listen(${port}, '127.0.0.1')`
  const result = await control.start({ command: `node -e ${JSON.stringify(script)}`, port })
  assert.equal(result.status, 'running')

  const logs = control.logs()
  assert.equal(logs.status, 'running')
  assert.deepEqual(logs.origins, result.origins)
  assert.match(logs.origins?.[port] ?? '', /^http:\/\/localhost:\d+$/)
  await control.stop()
})
