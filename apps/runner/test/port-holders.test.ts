// On a member's machine, a preview that cannot have a port says who holds it:
// before it starts, and when its app or its containers fail for want of one.
// And an app answering with a page that says it starts is waited on.
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const home = await mkdtemp(join(tmpdir(), 'brigade-port-holders-'))
process.env.BRIGADE_HOME = home
process.env.BRIGADE_PREVIEW_WAITING_MS = '3000'
delete process.env.BRIGADE_CLOUD
const { describeHolder, portHolders, takenPorts } = await import('../src/port-holders.js')
const { Previews } = await import('../src/previews.js')

const lsof = spawnSync('lsof', ['-v']).error === undefined
const children: ChildProcess[] = []
test.after(async () => {
  for (const child of children) child.kill()
  await rm(home, { recursive: true, force: true })
})

/** A port nothing listens on. */
async function freePort() {
  const server = createServer()
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as { port: number }
  await new Promise((done) => server.close(done))
  return port
}

/** A server in its own folder, as the member's own app would be. */
async function foreign(port: number) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'member-app-')))
  const child = spawn(
    process.execPath,
    ['-e', `require('http').createServer((q, s) => s.end('theirs')).listen(${port}, '127.0.0.1')`],
    { cwd: dir, stdio: 'ignore' },
  )
  children.push(child)
  for (let i = 0; i < 50 && !(await answers(port)); i++) await sleep(100)
  return { dir, child }
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
const answers = (port: number) =>
  fetch(`http://127.0.0.1:${port}`).then(
    () => true,
    () => false,
  )

const work = join(home, 'teammates', 'tm1', 'threads', 's1')
await mkdir(work, { recursive: true })
const seat = { sessionId: 's1', teammateId: 'tm1', workDir: work }
const previews = new Previews({
  emit: () => undefined,
  expose: null,
  viewUrl: null,
  recipes: async () => ({ recipe: null }),
  seat: () => seat,
  stateFile: join(home, 'state', 'previews.json'),
})
const control = previews.forSeat(seat)
const serve = (script: string) => `node -e ${JSON.stringify(script)}`

test('the ports a log says were taken', () => {
  const log = [
    '[12:03:45] Error: listen EADDRINUSE: address already in use :::3000',
    'Error response from daemon: driver failed programming external connectivity: Bind for 0.0.0.0:5432 failed: port is already allocated',
    'Error: ports are not available: exposing port TCP 0.0.0.0:6379 -> 0.0.0.0:0: listen tcp 0.0.0.0:6379: bind: address already in use',
    'Address already in use - bind(2) for "127.0.0.1" port 4000 (Errno::EADDRINUSE)',
    'Port 5173 is already in use',
    'Listening on :8080',
  ].join('\n')
  assert.deepEqual(takenPorts(log), [3000, 5432, 6379])
  assert.deepEqual(takenPorts(log.split('\n').slice(3).join('\n')), [4000, 5173])
})

test('a holder in words: the thread’s, another thread’s, the member’s, macOS’s', () => {
  const at = (cwd: string) => ({ pid: 7, command: 'node', cwd })
  assert.equal(
    describeHolder(
      { pid: 1, command: 'com.docker.backend', container: { name: 'db', project: 'ts1' } },
      's1',
    ),
    "this thread's container db",
  )
  assert.equal(
    describeHolder(
      { pid: 1, command: 'com.docker.backend', container: { name: 'db', project: 'tother' } },
      's1',
    ),
    'container db of another thread (Compose project tother)',
  )
  assert.equal(
    describeHolder(
      {
        pid: 1,
        command: 'com.docker.backend',
        container: {
          name: 'brigade-postgres-1',
          project: 'brigade',
          dir: '/Users/me/workspace/brigade',
        },
      },
      's1',
    ),
    "the member's own container brigade-postgres-1 (Compose project brigade in /Users/me/workspace/brigade)",
  )
  assert.match(describeHolder({ pid: 3, command: 'ControlCenter' }, 's1'), /AirPlay Receiver/)
  assert.equal(
    describeHolder(at(join(work, 'app')), 's1'),
    'node (pid 7), which this thread started',
  )
  assert.equal(
    describeHolder(at(join(home, 'teammates', 'tm2', 'threads', 's2', 'app')), 's1'),
    'node (pid 7) of another thread',
  )
  assert.equal(describeHolder(at('/Users/me/shop'), 's1'), 'node (pid 7, in /Users/me/shop)')
})

test('what listens on a port, and where it runs', { skip: !lsof && 'no lsof' }, async () => {
  const port = await freePort()
  const { dir, child } = await foreign(port)
  const holders = await portHolders(port)
  assert.deepEqual(
    holders.map((h) => ({ pid: h.pid, cwd: h.cwd })),
    [{ pid: child.pid, cwd: dir }],
  )
  assert.match(holders[0]!.command, /node/)
  assert.deepEqual(await portHolders(await freePort()), [])
})

test(
  'a port someone else holds is named before the preview starts',
  { skip: !lsof && 'no lsof' },
  async () => {
    const port = await freePort()
    const { dir } = await foreign(port)
    await assert.rejects(
      control.start({ command: serve('setInterval(() => {}, 1000)'), port }),
      new RegExp(
        `Port ${port} is held by node[^,]* \\(pid \\d+, in ${dir}\\), which is not this thread's: leave it running`,
      ),
    )
    // A command that takes $PORT runs on another one, and the teammate is told why.
    const result = await control.start({
      command: `${serve("require('http').createServer((q, s) => s.end('ours')).listen(Number(process.argv[1]), process.env.HOST)")} $PORT`,
      port,
    })
    assert.equal(result.status, 'running')
    assert.match(
      result.notes?.[0] ?? '',
      new RegExp(`^Port ${port} is held by node.*: the app runs on ${port + 1}`),
    )
    await control.stop()
  },
)

test(
  'an app that fails for want of a port says who holds it',
  { skip: !lsof && 'no lsof' },
  async () => {
    const taken = await freePort()
    await foreign(taken)
    const result = await control.start({
      command: serve(`require('http').createServer().listen(${taken}, '127.0.0.1')`),
      port: await freePort(),
    })
    assert.equal(result.status, 'failed')
    assert.match(
      result.reason ?? '',
      new RegExp(`exited with code 1: port ${taken} is held by node`),
    )
    assert.match(result.logs ?? '', new RegExp(`\\[preview\\] Port ${taken} is held by node`))
  },
)

test('an app answering that it starts (503) is waited on, a while', async () => {
  const port = await freePort()
  const started = Date.now()
  const result = await control.start({
    command: serve(
      `const t = Date.now(); require('http').createServer((q, s) => { s.statusCode = Date.now() - t < 1500 ? 503 : 200; s.end() }).listen(${port}, '127.0.0.1')`,
    ),
    port,
  })
  assert.equal(result.status, 'running')
  assert.ok(Date.now() - started >= 1400, `ready after ${Date.now() - started} ms`)
  await control.stop()

  // One that keeps saying so runs anyway once BRIGADE_PREVIEW_WAITING_MS passed: its check says the rest.
  const always = Date.now()
  const stuck = await control.start({
    command: serve(
      `require('http').createServer((q, s) => { s.statusCode = 503; s.end() }).listen(${port}, '127.0.0.1')`,
    ),
    port,
  })
  assert.equal(stuck.status, 'running')
  assert.ok(Date.now() - always >= 2900 && Date.now() - always < 20_000)
  await control.stop()
})
