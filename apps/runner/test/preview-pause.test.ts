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
// A docker that notes what it is asked, and has one running container in the thread's project.
const bin = join(home, 'bin')
const calls = join(home, 'docker-calls')
await mkdir(bin, { recursive: true })
await writeFile(
  join(bin, 'docker'),
  `#!/bin/sh\necho "$*" >> ${JSON.stringify(calls)}\ncase "$1" in ps) echo c1 ;; esac\n`,
)
await chmod(join(bin, 'docker'), 0o755)
process.env.PATH = `${bin}:${process.env.PATH}`
const { Previews, localName } = await import('../src/previews.js')

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
