// On a member's machine, a preview nobody uses stops where it is (SIGSTOP), with
// its thread's Compose containers, until the next request; it opens at the
// thread's own name under localhost, so its cookies are its own.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const home = await mkdtemp(join(tmpdir(), 'brigade-preview-pause-'))
process.env.BRIGADE_HOME = home
delete process.env.BRIGADE_CLOUD
process.env.BRIGADE_PREVIEW_FREEZE_MS = '1'
// A docker that notes what it is asked, with one running container in the thread's project.
const bin = join(home, 'bin')
const calls = join(home, 'docker-calls')
await mkdir(bin, { recursive: true })
// What it does is set by files beside it: the running containers it lists, those it fails to
// pause, those gone, and whether its daemon answers.
const state = (name: string) => join(home, `docker-${name}`)
await writeFile(
  join(bin, 'docker'),
  [
    '#!/bin/sh',
    `echo "$*" >> ${JSON.stringify(calls)}`,
    `has() { grep -qx "$2" "${home}/docker-$1" 2>/dev/null; }`,
    `touch "${home}/docker-entered"`,
    `while [ -e "${home}/docker-hold" ]; do sleep 0.05; done`,
    `[ -e "${home}/docker-down" ] && { echo 'Cannot connect to the Docker daemon' >&2; exit 1; }`,
    'case "$1" in',
    `  ps) cat "${home}/docker-running" 2>/dev/null || echo c1 ;;`,
    '  pause) has fails "$2" && { echo "$2 is not running" >&2; exit 1; } ;;',
    '  unpause) has gone "$2" && { echo "No such container: $2" >&2; exit 1; } ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n'),
)
await chmod(join(bin, 'docker'), 0o755)
process.env.PATH = `${bin}:${process.env.PATH}`
const { Previews, localName } = await import('../src/previews.js')
const { pauseMember, unpauseMember } = await import('../src/containers.js')

test.after(() => rm(home, { recursive: true, force: true }))

async function freePort() {
  const server = createServer()
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as { port: number }
  await new Promise((done) => server.close(done))
  return port
}

/** GET through the preview's proxy, as a browser at its name would. */
function get(origin: string) {
  const url = new URL(origin)
  return new Promise<string>((done, fail) => {
    http
      .get({ host: '127.0.0.1', port: url.port, path: '/', headers: { host: url.host } }, (res) => {
        let body = ''
        res.on('data', (d: Buffer) => (body += d.toString()))
        res.on('end', () => done(body))
      })
      .on('error', fail)
  })
}

const stopped = (pid: number) =>
  execFileSync('ps', ['-o', 'stat=', '-p', String(pid)])
    .toString()
    .includes('T')

const until = async (ok: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 100 && !(await ok()); i++) await new Promise((done) => setTimeout(done, 50))
  assert.ok(await ok())
}

test("a thread's own name under localhost", () => {
  assert.equal(localName('cmvqggkte000ppsp7k49j3v66'), 'cmvqggkte000ppsp7k49j3v66.localhost')
  assert.equal(localName('A_b-C'), 'ab-c.localhost')
})

test('a preview nobody uses stops with its containers, and the next request resumes both', async () => {
  const work = join(home, 'threads', 's1')
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
  const port = await freePort()
  const pidFile = join(home, 'pid')
  const script =
    `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` +
    `require('http').createServer((q, s) => s.end(q.headers.host)).listen(${port}, '127.0.0.1')`
  const result = await control.start({ command: `node -e ${JSON.stringify(script)}`, port })
  assert.equal(result.status, 'running')
  const origin = result.origins[port]!
  assert.match(origin, /^http:\/\/s1\.localhost:\d+$/)
  assert.equal(previews.origin('s1'), origin)
  const pid = Number(await readFile(pidFile, 'utf8'))

  // Unused past FREEZE_MS: stopped, and the thread's running containers paused.
  ;(previews as unknown as { expire(): void }).expire()
  await until(() => stopped(pid))
  await until(async () => (await readFile(calls, 'utf8').catch(() => '')).includes('pause c1'))
  assert.match(
    await readFile(calls, 'utf8'),
    /ps -q --no-trunc --filter label=com\.docker\.compose\.project=ts1 --filter status=running/,
  )

  // A request resumes it, with its containers; the app is asked for the name people opened.
  assert.equal(await get(origin), new URL(origin).host)
  assert.equal(stopped(pid), false)
  await until(async () => (await readFile(calls, 'utf8')).includes('unpause c1'))

  await control.stop()
})

test('a container that stopped since it was listed does not hide those already paused', async () => {
  await writeFile(state('running'), 'c1\nc2\nc3\n')
  await writeFile(state('fails'), 'c2\n')
  try {
    assert.deepEqual(await pauseMember('s2'), ['c1', 'c3'])
  } finally {
    await rm(state('running'))
    await rm(state('fails'))
  }
})

test('containers Docker did not resume stay noted, and are resumed once it answers', async () => {
  // Gone ones count as resumed; with Docker down, none does.
  await writeFile(state('gone'), 'c2\n')
  assert.deepEqual(await unpauseMember(['c1', 'c2']), [])
  await writeFile(state('down'), '')
  assert.deepEqual(await unpauseMember(['c1', 'c2']), ['c1', 'c2'])
  await rm(state('gone'))

  // A runner starting while Docker is down keeps the note of the one before it.
  const stateDir = join(home, 'state-left')
  await mkdir(stateDir, { recursive: true })
  const journal = join(stateDir, 'paused-containers.json')
  await writeFile(journal, JSON.stringify([['', 's3', ['c9']]]))
  const previews = new Previews({
    emit: () => undefined,
    expose: null,
    viewUrl: null,
    recipes: async () => ({ recipe: null }),
    seat: () => {
      throw new Error('unused')
    },
    stateFile: join(stateDir, 'previews.json'),
  })
  const retry = () => (previews as unknown as { resumeLeft(): Promise<void> }).resumeLeft()
  await retry()
  assert.deepEqual(JSON.parse(await readFile(journal, 'utf8')), [['', 's3', ['c9']]])

  // Once it answers, the next try resumes it and forgets it.
  await rm(state('down'))
  await retry()
  assert.deepEqual(JSON.parse(await readFile(journal, 'utf8')), [])
  assert.match(await readFile(calls, 'utf8'), /unpause c9/)
})

test('containers a wake is resuming stay noted while Docker answers, whatever else is saved', async () => {
  const stateDir = join(home, 'state-wake')
  await mkdir(stateDir, { recursive: true })
  const journal = join(stateDir, 'paused-containers.json')
  const previews = new Previews({
    emit: () => undefined,
    expose: null,
    viewUrl: null,
    recipes: async () => ({ recipe: null }),
    seat: () => {
      throw new Error('unused')
    },
    stateFile: join(stateDir, 'previews.json'),
  })
  type Inside = {
    previews: Map<string, unknown>
    savePaused(): void
    unpauseContainers(preview: unknown): Promise<void>
  }
  const inside = previews as unknown as Inside
  const preview = {
    seat: { sessionId: 's4' },
    pausedContainers: ['c4'],
    lines: [],
    partial: '',
    written: 0,
    hidden: [],
    info: {},
  }
  inside.previews.set('s4', preview)
  inside.savePaused()
  const noted = async () => JSON.parse(await readFile(journal, 'utf8')) as unknown
  assert.deepEqual(await noted(), [['', 's4', ['c4']]])

  // Docker is slow to answer, and down: another preview saves meanwhile.
  await writeFile(state('hold'), '')
  await writeFile(state('down'), '')
  await rm(state('entered'), { force: true })
  const waking = inside.unpauseContainers(preview)
  await until(async () => (await readFile(state('entered')).catch(() => null)) !== null)
  inside.savePaused()
  assert.deepEqual(await noted(), [['', 's4', ['c4']]])

  await rm(state('hold'))
  await waking
  assert.deepEqual(await noted(), [['', 's4', ['c4']]])
  await rm(state('down'))
  inside.previews.delete('s4')
})
