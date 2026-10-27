// An update hands running turns over: their harnesses outlive the runner, and the next one
// keeps them for the threads that take them up.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const home = await mkdtemp(join(tmpdir(), 'brigade-hand-over-'))
process.env.BRIGADE_HOME = home
test.after(() => rm(home, { recursive: true, force: true }))
const { claimHandOver, noteHandOver, takeHandOver } = await import('../src/hand-over.js')
const { closeTurn } = await import('../src/harness/closed-turn.js')

test('the next runner keeps the groups handed over, once, and only fresh ones', async () => {
  noteHandOver([{ pgid: 4242 }, { pgid: 4343, runAs: 'teammate-a' }])
  assert.deepEqual([...takeHandOver()], [4242, 4343])
  assert.equal(claimHandOver(4242), true)
  assert.equal(claimHandOver(4242), false)
  // Read once: a runner after this one keeps nothing from it.
  assert.deepEqual([...takeHandOver()], [])
  // A note from an earlier restart names groups that are not ours any more.
  const file = join(home, 'state', 'hand-over.json')
  await writeFile(file, JSON.stringify({ at: Date.now() - 3_600_000, groups: [{ pgid: 4444 }] }))
  assert.deepEqual([...takeHandOver()], [])
})

test('a turn frozen while a Brigade tool answered waits on nobody', () => {
  const frozen = {
    type: 'resume-session',
    harnessId: 'claude-code',
    specificationVersion: 'harness-v1',
    data: {},
    continueFrom: {
      type: 'continue-turn',
      harnessId: 'claude-code',
      specificationVersion: 'harness-v1',
      data: { bridge: { port: 41000, token: 't', lastSeenEventId: 9 } },
      pendingToolResults: [
        {
          toolCallId: 'toolu_1',
          toolName: 'check_preview',
          input: '{}',
          completedResult: { output: { ok: true } },
        },
      ],
    },
  }
  assert.equal(closeTurn(frozen), undefined)
})

test("a harness's bridge goes on writing once the runner that started it is gone", async () => {
  // A "runner" starts a process that writes all the time, the way a bridge is started, and exits.
  const log = join(home, 'writer.log')
  const writer = join(home, 'writer.mjs')
  await writeFile(
    writer,
    `import { appendFileSync } from 'node:fs'
     process.on('uncaughtException', (e) => appendFileSync(${JSON.stringify(log)}, 'error ' + (e.code ?? e.message) + '\\n'))
     let n = 0
     setInterval(() => { n++; process.stdout.write('out\\n'); process.stderr.write('err\\n'); appendFileSync(${JSON.stringify(log)}, 'alive ' + n + '\\n') }, 50)`,
  )
  const sandbox = fileURLToPath(new URL('../src/harness/local-sandbox.ts', import.meta.url))
  const runner = join(home, 'runner.mts')
  await writeFile(
    runner,
    `import { createLocalSandboxSession } from ${JSON.stringify(sandbox)}
     const s = createLocalSandboxSession({ id: 't', workingDirectory: ${JSON.stringify(home)}, port: 1, env: { PATH: process.env.PATH } })
     const p = await s.restricted().spawn({ command: 'exec node ${writer}', env: { BRIGADE_HOME: ${JSON.stringify(home)}, BRIDGE_WS_PORT: '1' } })
     console.log(p.pid)
     await p.stdout.getReader().read()
     process.exit(0)`,
  )
  const started = spawn(process.execPath, ['--import', 'tsx', runner], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  let out = ''
  started.stdout.on('data', (d: Buffer) => (out += d))
  await new Promise((done) => started.once('exit', done))
  const pgid = Number(out.trim())
  test.after(() => process.kill(-pgid, 'SIGTERM'))
  const lines = async () => (await readFile(log, 'utf8')).trim().split('\n')
  const before = (await lines()).length
  await new Promise((done) => setTimeout(done, 600))
  const after = await lines()
  assert.ok(after.length > before + 5, 'it goes on')
  assert.deepEqual(
    after.filter((l) => l.startsWith('error')),
    [],
  )
})

test('a bridge handed over is stopped once the harness started one of its own instead', async () => {
  const { createLocalSandboxSession } = await import('../src/harness/local-sandbox.js')
  const old = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
  const gone = new Promise((done) => old.once('exit', done))
  const s = createLocalSandboxSession({
    id: 'adopt',
    workingDirectory: home,
    port: 1,
    env: { PATH: process.env.PATH! },
    adopt: [old.pid!],
  })
  test.after(() => s.destroy?.())
  // Attached: the harness started nothing, the handed-over bridge is the one.
  assert.equal(s.dropAdopted(), false)
  assert.deepEqual(s.groups(), [old.pid])
  // Attaching failed and a new bridge runs: the old one goes now, not with the sandbox.
  const fresh = await s.restricted().spawn({ command: 'exec sleep 30' })
  assert.equal(s.dropAdopted(), true)
  await gone
  assert.deepEqual(s.groups(), [fresh.pid])
  assert.equal(s.dropAdopted(), false)
})
