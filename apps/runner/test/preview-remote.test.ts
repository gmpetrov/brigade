import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

// A preview on a machine of its own, through the runner's Previews (previews.ts), with the
// machine stood in for by a folder here:
// - a launch a stop cut short gives up before it changes anything on the machine, and the
//   replacement's launch starts there only once the old preview's cleanup is over;
// - woken after it slept, the preview runs its setup again: what the setup started (a database)
//   stopped with the machine.
const home = mkdtempSync(join(tmpdir(), 'preview-remote-'))
process.env.BRIGADE_HOME = join(home, 'runner')
delete process.env.BRIGADE_CLOUD
const { Previews } = await import('../src/previews.js')
after(() => rmSync(home, { recursive: true, force: true }))

/** A stand-in for the SSH link: commands run in `dir`, in a session of their own, as sshd's. */
function folderLink(dir: string, log: string[], name: string) {
  const spawnHere = (command: string, stdio: 'pipe' | 'ignore' = 'pipe') =>
    spawn('sh', ['-c', command], {
      cwd: dir,
      detached: true,
      stdio: [stdio === 'pipe' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    })
  return {
    size: 'test',
    connect: async () => undefined,
    close: () => undefined,
    update: () => undefined,
    alive: async () => true,
    spawn: spawnHere,
    exec: (command: string, input = '') =>
      new Promise<string>((done, fail) => {
        log.push(`${name}: ${command}`)
        const child = spawnHere(command)
        let out = ''
        child.stdout!.on('data', (d: Buffer) => (out += d.toString()))
        child.on('close', (code) => (code === 0 ? done(out) : fail(new Error(`exit ${code}`))))
        // A command that does not read its input closes the pipe: not an error.
        child.stdin!.on('error', () => undefined)
        child.stdin!.end(input)
      }),
    forward: async (port: number) => port,
    local: (port: number) => port,
    answers: (port: number) =>
      new Promise<boolean>((done) => {
        const socket = createConnection(port, '127.0.0.1')
        socket.once('connect', () => {
          socket.destroy()
          done(true)
        })
        socket.once('error', () => done(false))
      }),
  }
}

async function freePort() {
  const server = createServer()
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as { port: number }).port
  await new Promise<void>((done) => server.close(() => done()))
  return port
}

const machines = (calls: string[]) => ({
  home: join(home, 'runner'),
  up: async (sessionId: string) => {
    calls.push(`up ${sessionId}`)
    return {
      machine: { id: 'm', host: 'h', port: 22, user: 'u', hostKey: 'k', size: 'test' },
    }
  },
  sleep: async (sessionId: string) => void calls.push(`sleep ${sessionId}`),
  touch: async (sessionId: string) => void calls.push(`touch ${sessionId}`),
})

type Manager = InstanceType<typeof Previews> & Record<string, unknown>

test('a launch cut short changes nothing on the machine; the next starts after the cleanup', async () => {
  const machine = join(home, 'cut')
  mkdirSync(machine, { recursive: true })
  const seat = { sessionId: 's1', teammateId: 't', workDir: machine }
  const log: string[] = []
  const calls: string[] = []
  const manager = new Previews({
    emit: () => undefined,
    expose: null,
    viewUrl: null,
    recipes: async () => ({ recipe: null }),
    seat: () => seat,
    stateFile: join(machine, 'state.json'),
    machines: machines(calls),
  }) as Manager
  // The old preview's connection is slow to open: it is stopped and replaced meanwhile.
  let opened!: () => void
  let entered!: () => void
  const entering = new Promise<void>((done) => (entered = done))
  const slow = folderLink(machine, log, 'old')
  slow.connect = async () => {
    entered()
    await new Promise<void>((done) => (opened = done))
  }
  const old = {
    seat,
    info: { status: 'starting', ports: [], command: 'echo old' },
    input: { port: 3000 },
    remote: {
      link: slow,
      sync: { flush: async () => undefined, stop: () => undefined },
      dir: '.',
      env: {},
      touchedAt: Date.now(),
      log: () => undefined,
      keepAwake: true,
    },
    envFiles: [],
    pausing: Promise.resolve(),
    exited: Promise.resolve(null),
    proxy: { close: () => undefined },
    lines: [],
    partial: '',
    written: 0,
    restarts: [],
    notes: [],
    hidden: [],
    variables: [],
    lastUsed: Date.now(),
  }
  ;(manager.previews as Map<string, unknown>).set('s1', old)
  const launching = (manager.launchRemote as (p: unknown, s: boolean) => Promise<void>).call(
    manager,
    old,
    false,
  )
  await entering
  const stopping = manager.stop('s1', 'Replaced by a new preview')
  opened()
  await stopping
  await launching
  // The replacement launches on the same machine.
  const fresh = {
    ...old,
    stopping: undefined,
    info: { status: 'starting', ports: [], command: 'echo new' },
    remote: { ...old.remote, link: folderLink(machine, log, 'new'), launching: undefined },
    exited: Promise.resolve(null),
  }
  ;(manager.previews as Map<string, unknown>).set('s1', fresh)
  await (manager.launchRemote as (p: unknown, s: boolean) => Promise<void>).call(
    manager,
    fresh,
    false,
  )
  const firstNew = log.findIndex((line) => line.startsWith('new:'))
  assert.ok(firstNew >= 0, 'the replacement ran')
  assert.ok(
    !log.some((line) => line.startsWith('old:') && line.includes('app.sh')),
    'the old launch never wrote its script',
  )
  assert.ok(
    log.slice(firstNew).every((line) => line.startsWith('new:')),
    `nothing of the old preview after the new one began:\n${log.join('\n')}`,
  )
  await manager.stop('s1', 'done')
  await settled(manager, 's1')
})

/** Once what was queued on the thread's machine is over (a stop's cleanup is not awaited). */
async function settled(manager: Manager, sessionId: string) {
  for (let i = 0; i < 50; i++) {
    const work = (manager.machineWork as Map<string, Promise<void>>).get(sessionId)
    if (!work) return
    await work
  }
}

test('woken after it slept, the preview runs its setup again', async () => {
  const machine = join(home, 'wake')
  const app = join(machine, 'work/app')
  mkdirSync(app, { recursive: true })
  const dbPort = await freePort()
  const appPort = await freePort()
  // The setup starts a database; the app answers 200 while it does, 500 once it is down.
  writeFileSync(
    join(app, 'database.cjs'),
    `require('http').createServer((q, s) => s.end('up')).listen(${dbPort}, '127.0.0.1')`,
  )
  writeFileSync(
    join(app, 'app.cjs'),
    `const http = require('http')
http.createServer((q, s) => http.get('http://127.0.0.1:${dbPort}', (r) => r.pipe(s)).on('error', () => {
  s.statusCode = 500
  s.end('database down')
})).listen(${appPort}, '127.0.0.1')`,
  )
  const log: string[] = []
  const calls: string[] = []
  const seat = { sessionId: 's2', teammateId: 't', workDir: app }
  const manager = new Previews({
    emit: () => undefined,
    expose: null,
    viewUrl: null,
    recipes: async () => ({ recipe: null }),
    seat: () => seat,
    stateFile: join(machine, 'state.json'),
    machines: machines(calls),
  }) as Manager
  const remote = {
    link: folderLink(machine, log, 'm'),
    sync: { flush: async () => undefined, stop: () => undefined },
    dir: 'work/app',
    env: {},
    touchedAt: Date.now(),
    log: () => undefined,
  }
  manager.machineFor = async () => remote
  try {
    const started = await manager.forSeat(seat).start({
      port: appPort,
      setup: 'node database.cjs > /dev/null 2>&1 &',
      command: 'node app.cjs',
      timeoutMs: 20_000,
    })
    assert.equal(started.status, 'running')
    assert.equal((await fetch(`http://127.0.0.1:${appPort}`)).status, 200)
    const preview = (manager.previews as Map<string, unknown>).get('s2')
    await (manager.sleepRemote as (p: unknown, r: unknown) => Promise<void>).call(
      manager,
      preview,
      remote,
    )
    await (manager.wake as (p: unknown) => Promise<void>).call(manager, preview)
    const woken = await fetch(`http://127.0.0.1:${appPort}`)
    assert.equal(woken.status, 200, 'its database runs again')
    assert.deepEqual(
      calls.filter((c) => !c.startsWith('touch')),
      ['sleep s2', 'up s2'],
      'stopped while asleep, started again to wake',
    )
  } finally {
    await manager.stop('s2', 'done')
    await settled(manager, 's2')
  }
})
