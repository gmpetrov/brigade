import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import http from 'node:http'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

// Previews survive an update of the runner (previews.ts, handOver and adopt): the runner before
// hands them over and exits, and the next one takes them up where they are.
// - A preview a runner started (in a process of its own here, which exits as an updating runner
//   does) keeps running: it answers, its log goes on in the next runner, at the same address,
//   and a later stop there ends it all.
// - A frozen one is taken up frozen: still stopped, and the next request resumes it.
// - One whose app died meanwhile starts again, and says why.
// - On a machine of its own, the app runs detached there: the next runner reaches its machine
//   again, follows its log from where it was, and holds the machine for it.
const home = mkdtempSync(join(tmpdir(), 'preview-handover-'))
process.env.BRIGADE_HOME = join(home, 'runner')
delete process.env.BRIGADE_CLOUD
process.env.BRIGADE_PREVIEW_OUTPUT_MAX = String(16 * 1024)
const { Previews } = await import('../src/previews.js')
after(() => rmSync(home, { recursive: true, force: true }))

const SOURCE = new URL('../src/previews.ts', import.meta.url).href
type Manager = InstanceType<typeof Previews> & Record<string, unknown>

async function freePort() {
  const server = createServer()
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as { port: number }).port
  await new Promise<void>((done) => server.close(() => done()))
  return port
}

const until = async (ok: () => boolean | Promise<boolean>, what: string) => {
  for (let i = 0; i < 200; i++) {
    if (await ok()) return
    await new Promise((done) => setTimeout(done, 50))
  }
  assert.fail(`still not so after 10 s: ${what}`)
}

const running = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const stopped = (pid: number) =>
  execFileSync('ps', ['-o', 'stat=', '-p', String(pid)])
    .toString()
    .includes('T')

/** GET, as a browser at the address would: its body, or null when nothing answers. */
function get(url: string, timeoutMs = 5000) {
  const { hostname, port } = new URL(url)
  return new Promise<string | null>((done) => {
    const request = http.get(
      {
        host: '127.0.0.1',
        port,
        path: '/',
        headers: { host: `${hostname}:${port}` },
        timeout: timeoutMs,
      },
      (res) => {
        let body = ''
        res.on('data', (d: Buffer) => (body += d.toString()))
        res.on('end', () => done(res.statusCode === 200 ? body : null))
      },
    )
    request.on('timeout', () => request.destroy())
    request.on('error', () => done(null))
  })
}

/** A folder for a thread's checkout, with an app that says each request it answers. */
function app(name: string) {
  const work = join(home, name)
  mkdirSync(work, { recursive: true })
  writeFileSync(
    join(work, 'app.cjs'),
    `require('fs').writeFileSync('app.pid', String(process.pid))
let n = 0
require('http')
  .createServer((q, s) => {
    console.log('hit ' + ++n + ' by ' + process.pid)
    if (process.env.TOKEN) console.log('token ' + process.env.TOKEN)
    s.end('ok ' + process.pid)
  })
  .listen(Number(process.env.PORT), '127.0.0.1', () => console.log('listening'))
`,
  )
  return work
}

/**
 * A runner before this one, in a process of its own: it starts the preview, does `then` (freeze
 * it), hands it over and exits, as an updating runner does. Its start's result.
 */
type Variables = { env: Record<string, string>; secrets: string[] }

/** A repository's preview variables, as the API gives them. */
const recipes = (variables?: Variables) => async (_s: string, _t: string, op: { name: string }) =>
  op.name === 'variables' ? (variables ?? { env: {}, secrets: [] }) : { recipe: null }

async function runnerBefore(
  seat: object,
  stateFile: string,
  port: number,
  then = '',
  variables?: Variables,
) {
  const code = `
const { Previews } = await import(${JSON.stringify(SOURCE)})
const seat = ${JSON.stringify(seat)}
const previews = new Previews({
  emit: () => undefined,
  expose: null,
  viewUrl: null,
  recipes: async (_s, _t, op) =>
    op.name === 'variables' ? ${JSON.stringify(variables ?? { env: {}, secrets: [] })} : { recipe: null },
  seat: () => seat,
  stateFile: ${JSON.stringify(stateFile)},
})
const result = await previews.forSeat(seat).start({
  command: 'node app.cjs',
  port: ${port},
  ${variables ? "repository: 'acme/app'," : ''}
})
await new Promise((done) => setTimeout(done, 300))
${then}
await previews.handOver()
console.log(JSON.stringify(result))
process.exit(0)
`
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    env: { ...process.env, BRIGADE_PREVIEW_FREEZE_MS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  let err = ''
  child.stdout.on('data', (d: Buffer) => (out += d.toString()))
  child.stderr.on('data', (d: Buffer) => (err += d.toString()))
  const exit = await new Promise((done) => child.on('close', done))
  assert.equal(exit, 0, `the runner before exited: ${err}`)
  const result = JSON.parse(out.trim().split('\n').pop()!) as {
    status: string
    origins: Record<number, string>
  }
  assert.equal(result.status, 'running', err)
  return result
}

function nextRunner(
  seat: { sessionId: string },
  stateFile: string,
  events: unknown[] = [],
  variables?: Variables,
) {
  return new Previews({
    emit: (_sessionId, event) => events.push(event),
    expose: null,
    viewUrl: null,
    recipes: recipes(variables) as never,
    seat: () => seat as never,
    stateFile,
  }) as Manager
}

test('a preview goes on through an update: it answers, its log goes on, a later stop ends it', async () => {
  const work = app('kept')
  const seat = { sessionId: 'kept', teammateId: 't', workDir: work }
  const stateFile = join(home, 'kept-state', 'previews.json')
  const port = await freePort()
  const before = await runnerBefore(
    seat,
    stateFile,
    port,
    `await fetch('http://127.0.0.1:${port}/')`,
  )
  const origin = before.origins[port]!
  const pid = Number(readFileSync(join(work, 'app.pid'), 'utf8'))

  // The runner before is gone; its app is not, and still writes its output.
  assert.ok(running(pid), 'the app outlived the runner that started it')
  assert.match((await get(`http://127.0.0.1:${port}/`))!, new RegExp(`ok ${pid}`))
  assert.ok(running(pid), 'writing its output after its runner exited did not end it')

  // Kept by the next runner, not stopped as what its runner left (process-groups.ts, on a Mac).
  const group = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)]).toString())
  assert.deepEqual(Previews.handedOverGroups(stateFile), [group])

  const events: { type?: string; status?: string }[] = []
  const previews = nextRunner(seat, stateFile, events)
  try {
    await previews.adopt()
    assert.equal(previews.has('kept'), true)
    assert.equal(previews.origin('kept'), origin, 'the same address')
    assert.equal(await get(origin), `ok ${pid}`, 'its proxy listens again, before the same app')
    // What it wrote before, while no runner read it, and since.
    await until(() => previews.logs('kept').includes('hit 3 by'), 'its log goes on')
    const log = previews.logs('kept')
    assert.match(log, /listening\nhit 1 by \d+\nhit 2 by \d+\nhit 3 by \d+/, log)
    assert.equal(
      log.match(/hit 1 by/g)?.length,
      1,
      'nothing read twice: the next runner reads on from where the last one was',
    )
    assert.ok(
      events.some((e) => e.type === 'preview.changed' && e.status === 'running'),
      'said running by this runner',
    )
    assert.ok(!events.some((e) => e.status === 'stopped' || e.status === 'failed'))
  } finally {
    await previews.stop('kept', 'done')
  }
  await until(() => !running(pid), 'a stop ends the app')
  assert.equal(await get(origin, 1000), null, 'and its proxy')
})

test('a frozen preview is taken up frozen, and the next request resumes it', async () => {
  const work = app('frozen')
  const seat = { sessionId: 'frozen', teammateId: 't', workDir: work }
  const stateFile = join(home, 'frozen-state', 'previews.json')
  const port = await freePort()
  const before = await runnerBefore(seat, stateFile, port, 'previews.expire()')
  const origin = before.origins[port]!
  const pid = Number(readFileSync(join(work, 'app.pid'), 'utf8'))
  assert.ok(stopped(pid), 'frozen by the runner before')

  const previews = nextRunner(seat, stateFile)
  try {
    await previews.adopt()
    await new Promise((done) => setTimeout(done, 300))
    assert.ok(stopped(pid), 'still frozen once taken up')
    assert.equal(previews.count, 0, 'not counted as in use')
    assert.equal(await get(origin), `ok ${pid}`, 'a request resumes it')
    assert.equal(stopped(pid), false)
  } finally {
    await previews.stop('frozen', 'done')
  }
  await until(() => !running(pid), 'a stop ends it')
})

test('a preview whose app died meanwhile starts again, and says why', async () => {
  const work = app('dead')
  const seat = { sessionId: 'dead', teammateId: 't', workDir: work }
  const stateFile = join(home, 'dead-state', 'previews.json')
  const port = await freePort()
  const before = await runnerBefore(seat, stateFile, port)
  const pid = Number(readFileSync(join(work, 'app.pid'), 'utf8'))
  process.kill(pid, 'SIGKILL')
  await until(() => !running(pid), 'the app died')

  const events: { type?: string; status?: string; reason?: string }[] = []
  const previews = nextRunner(seat, stateFile, events)
  try {
    await previews.adopt()
    await previews.startAgain()
    await until(
      async () => (await get(before.origins[port]!))?.startsWith('ok ') === true,
      'it runs again',
    )
    const again = Number(readFileSync(join(work, 'app.pid'), 'utf8'))
    assert.notEqual(again, pid, 'a new app')
    assert.match(
      previews.logs('dead'),
      /Started again after Brigade updated: its app stopped while Brigade updated/,
    )
  } finally {
    await previews.stop('dead', 'done')
  }
})

/** A stand-in for the SSH link: commands run in `dir`, in a session of their own, as sshd's. */
function folderLink(dir: string) {
  const spawnHere = (command: string, stdio: 'pipe' | 'ignore' = 'pipe') =>
    spawn('sh', ['-c', command], {
      cwd: dir,
      detached: true,
      stdio: [stdio === 'pipe' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    })
  return {
    size: 'test',
    machine: { id: 'm', host: 'h', port: 22, user: 'u', hostKey: 'k', size: 'test' },
    connect: async () => undefined,
    close: () => undefined,
    update: () => undefined,
    alive: async () => true,
    spawn: spawnHere,
    exec: (command: string, input = '') =>
      new Promise<string>((done, fail) => {
        const child = spawnHere(command)
        let out = ''
        child.stdout!.on('data', (d: Buffer) => (out += d.toString()))
        child.on('close', (code) => (code === 0 ? done(out) : fail(new Error(`exit ${code}`))))
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

test('on its machine, the app runs on through an update and the next runner follows it', async () => {
  const machine = join(home, 'machine')
  const work = join(machine, 'work/app')
  mkdirSync(work, { recursive: true })
  writeFileSync(join(work, 'app.cjs'), readFileSync(join(app('remote-source'), 'app.cjs')))
  const seat = { sessionId: 'remote', teammateId: 't', workDir: work }
  const stateFile = join(home, 'remote-state', 'previews.json')
  const calls: string[] = []
  const machines = {
    home: join(home, 'runner'),
    up: async (sessionId: string) => {
      calls.push(`up ${sessionId}`)
      return { machine: folderLink(machine).machine }
    },
    sleep: async (sessionId: string) => void calls.push(`sleep ${sessionId}`),
    touch: async () => undefined,
  }
  const remote = (root: string) => ({
    link: folderLink(machine),
    sync: { flush: async () => undefined, stop: () => undefined },
    dir: 'work/app',
    env: {},
    touchedAt: Date.now(),
    log: () => undefined,
    root,
    includes: [],
  })
  const options = (events: unknown[] = []) => ({
    emit: (_sessionId: string, event: unknown) => events.push(event),
    expose: null,
    viewUrl: null,
    recipes: async () => ({ recipe: null }),
    seat: () => seat,
    stateFile,
    machines,
  })
  const port = await freePort()
  const before = new Previews(options()) as Manager
  before.machineFor = async () => remote(work)
  const started = await before
    .forSeat(seat)
    .start({ command: 'node app.cjs', port, timeoutMs: 20_000 })
  assert.equal(started.status, 'running')
  await get(`http://127.0.0.1:${port}/`)
  await until(() => before.logs('remote').includes('hit 1 by'), 'its log, read there')
  await before.handOver()
  const pid = Number(readFileSync(join(work, 'app.pid'), 'utf8'))
  assert.ok(running(pid), 'the app runs on, detached on its machine')
  assert.ok(!calls.includes('sleep remote'), 'its machine stays up for the next runner')
  // Written while no runner follows it.
  await get(`http://127.0.0.1:${port}/`)

  const previews = new Previews(options()) as Manager
  previews.remoteFor = (_s: unknown, _n: unknown, _l: unknown, _d: unknown, root: string) =>
    remote(root)
  calls.length = 0
  try {
    await previews.adopt()
    await previews.startAgain()
    assert.deepEqual(calls, ['up remote'], 'held for the preview again, its machine not stopped')
    assert.equal(await get(previews.origin('remote')!), `ok ${pid}`, 'the same app, reached again')
    await until(() => previews.logs('remote').includes('hit 3 by'), 'its log goes on')
    const log = previews.logs('remote')
    assert.equal(log.match(/hit 1 by/g)?.length, 1, `read on from where it was:\n${log}`)
    assert.match(log, /hit 2 by/)
  } finally {
    await previews.stop('remote', 'done')
    for (let i = 0; i < 50; i++) {
      const work = (previews.machineWork as Map<string, Promise<void>>).get('remote')
      if (!work) break
      await work
    }
  }
  await until(() => !running(pid), 'a stop ends it there')
  assert.ok(calls.includes('sleep remote'), 'and its machine sleeps')
})

test('its log hides the secrets the app was given, even once they changed', async () => {
  const work = app('secret')
  const seat = { sessionId: 'secret', teammateId: 't', workDir: work }
  const stateFile = join(home, 'secret-state', 'previews.json')
  const port = await freePort()
  const before = await runnerBefore(
    seat,
    stateFile,
    port,
    `await fetch('http://127.0.0.1:${port}/')`,
    { env: { TOKEN: 'old-secret-value' }, secrets: ['TOKEN'] },
  )
  const pid = Number(readFileSync(join(work, 'app.pid'), 'utf8'))
  // Changed in Brigade meanwhile: the app still holds the old one.
  const previews = nextRunner(seat, stateFile, [], {
    env: { TOKEN: 'new-secret-value' },
    secrets: ['TOKEN'],
  })
  try {
    await previews.adopt()
    await previews.startAgain()
    assert.equal(await get(before.origins[port]!), `ok ${pid}`)
    await until(() => previews.logs('secret').includes('hit 2 by'), 'its log goes on')
    await new Promise((done) => setTimeout(done, 400))
    const log = previews.logs('secret')
    assert.doesNotMatch(log, /old-secret-value/, log)
    assert.match(log, /hit 2 by \d+\ntoken ••••••/, log)
  } finally {
    await previews.stop('secret', 'done')
  }
})

test('a long log gives its disk back as it is read, losing nothing the app writes meanwhile', async () => {
  const stateFile = join(home, 'long-state', 'previews.json')
  mkdirSync(join(home, 'long-state'), { recursive: true })
  const previews = nextRunner({ sessionId: 'long' }, stateFile) as Manager & {
    took(preview: unknown, run: { offset: number }, chunk: Buffer): void
  }
  const preview = {
    seat: { sessionId: 'long' },
    info: { previewId: 'long-run-1' },
    lines: [] as string[],
    partial: '',
    written: 0,
    hidden: [],
  }
  const files = (
    previews.runFiles as (p: unknown, id: string) => { dir: string; output: string }
  ).call(previews, preview, 'r1')
  mkdirSync(files.dir, { recursive: true })
  const line = `${'x'.repeat(1023)}\n`
  writeFileSync(files.output, line.repeat(64))
  // The app writes on while a read is under way, past the size that read began from.
  const took = previews.took.bind(previews)
  let wrote = false
  previews.took = (p, run, chunk) => {
    took(p, run, chunk)
    if (!wrote && run.offset >= 32 * 1024) {
      wrote = true
      appendFileSync(files.output, 'written meanwhile\n')
    }
  }
  const run = (
    previews.newRun as (pid: number, offset: number, id: string) => { stopFollowing(): void }
  ).call(previews, process.pid, 0, 'r1')
  ;(previews.followLocal as (p: unknown, r: unknown) => void).call(previews, preview, run)
  try {
    await until(() => preview.lines.includes('written meanwhile'), 'what it wrote meanwhile, read')
    assert.equal(preview.lines.filter((l) => l.startsWith('x')).length, 64)
    const blocks = () => Number(execFileSync('stat', ['-c', '%b', files.output]).toString())
    // 65 KB written, 16 KB at most kept once read (BRIGADE_PREVIEW_OUTPUT_MAX).
    await until(() => blocks() * 512 <= 20 * 1024, 'its disk given back')
    assert.ok(statSync(files.output).size > 64 * 1024, 'its size, and so its offsets, the same')
  } finally {
    run.stopFollowing()
  }
})

test('where its disk cannot be given back (macOS without holes), a long log is emptied instead', async () => {
  const stateFile = join(home, 'cut-state', 'previews.json')
  mkdirSync(join(home, 'cut-state'), { recursive: true })
  const previews = nextRunner({ sessionId: 'cut' }, stateFile)
  const preview = {
    seat: { sessionId: 'cut' },
    info: { previewId: 'cut-run-1' },
    lines: [] as string[],
    partial: '',
    written: 0,
    hidden: [],
  }
  const files = (
    previews.runFiles as (p: unknown, id: string) => { dir: string; output: string }
  ).call(previews, preview, 'r1')
  mkdirSync(files.dir, { recursive: true })
  writeFileSync(files.output, `${'y'.repeat(1023)}\n`.repeat(100))
  const run = (
    previews.newRun as (
      pid: number,
      offset: number,
      id: string,
    ) => { stopFollowing(): void; release?: unknown }
  ).call(previews, process.pid, 0, 'r1')
  ;(previews.followLocal as (p: unknown, r: unknown) => void).call(previews, preview, run)
  // As on a filesystem, or a system, that cannot make holes.
  run.release = async () => {
    throw new Error('Operation not supported')
  }
  try {
    await until(() => statSync(files.output).size === 0, 'emptied once read')
    assert.equal(preview.lines.filter((l) => l.startsWith('y')).length, 100, 'all of it read first')
    assert.ok(
      preview.lines.some((l) => /Its log file was emptied at/.test(l)),
      'and said',
    )
    appendFileSync(files.output, 'after the cut\n')
    await until(() => preview.lines.includes('after the cut'), 'read on from its start')
  } finally {
    run.stopFollowing()
  }
})

test('a preview whose masks were lost is not handed over again with others', async () => {
  const work = app('lost-masks')
  const seat = { sessionId: 'lost-masks', teammateId: 't', workDir: work }
  const stateFile = join(home, 'lost-masks-state', 'previews.json')
  const port = await freePort()
  const before = await runnerBefore(
    seat,
    stateFile,
    port,
    `await fetch('http://127.0.0.1:${port}/')`,
    { env: { TOKEN: 'first-secret-value' }, secrets: ['TOKEN'] },
  )
  const first = Number(readFileSync(join(work, 'app.pid'), 'utf8'))
  // What its log hides, lost between two runners.
  for (const name of readdirSync(join(home, 'lost-masks-state', 'preview-runs')))
    rmSync(join(home, 'lost-masks-state', 'preview-runs', name, 'hidden'), { force: true })
  const changed = { env: { TOKEN: 'second-secret-value' }, secrets: ['TOKEN'] }
  const middle = nextRunner(seat, stateFile, [], changed)
  await middle.adopt()
  await middle.startAgain()
  assert.equal(await get(before.origins[port]!), `ok ${first}`, 'taken up, its output hidden')
  await middle.handOver()
  assert.ok(!running(first), 'stopped rather than handed over')

  const last = nextRunner(seat, stateFile, [], changed)
  try {
    await last.adopt()
    await last.startAgain()
    await until(
      async () => (await get(before.origins[port]!))?.startsWith('ok ') === true,
      'started again',
    )
    await get(before.origins[port]!)
    // Read for a while: whatever app answers prints its token on each request.
    await new Promise((done) => setTimeout(done, 800))
    assert.match(last.logs('lost-masks'), /token ••••••/)
    assert.doesNotMatch(last.logs('lost-masks'), /first-secret-value/)
  } finally {
    await last.stop('lost-masks', 'done')
  }
})
