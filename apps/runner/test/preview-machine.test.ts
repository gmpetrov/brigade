import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import {
  appState,
  clearRun,
  envFileText,
  freeOutput,
  MachineSync,
  readOutput,
  remoteScript,
  shellQuote,
  signalApp,
  startApp,
  writeRun,
  type MachineLink,
} from '../src/preview-machine.js'

// A preview on a machine of its own, from the runner's side (preview-machine.ts), with a stand-in
// for the SSH link that runs each command in a folder here, as the machine's home:
// - the sync starts the reader here and the receiver there, sends the whole checkout, then
//   each change, and starts again after it was cut, sending only what changed;
// - a flush waits as long as bytes go to the machine (large files), and gives up once none do;
//   it fails when the machine's copy of a file is not whole (it changed while it went), naming it;
// - the app's script sources its settings and credentials, runs the setup only when asked, and
//   its whole process group stops when signalled, what it left included;
// - it runs detached, its output in a file read from any byte on, and how it ended noted there.

const src = join(dirname(fileURLToPath(import.meta.url)), '../src')
/** tsx's loader by its path: the stand-in machine's commands run in a folder without it. */
const tsx = import.meta.resolve('tsx')
const made: string[] = []
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})
function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'preview-machine-'))
  made.push(dir)
  return dir
}

/**
 * Commands "on the machine" run in `home`, in a session of their own as sshd starts them. The
 * receiver copied there is TypeScript in tests: run with tsx instead. `before`: what its input
 * goes through first (a slow link); `receiver`: a script that stands in for it.
 */
function fakeLink(home: string, before = '', receiver?: string) {
  const command = (line: string) =>
    line.replace(
      'node .brigade/preview-sync-receiver.mjs',
      receiver
        ? `node ${shellQuote(receiver)}`
        : `${before}node --import ${shellQuote(tsx)} ${shellQuote(join(src, 'preview-sync-receiver.ts'))}`,
    )
  const spawnHere = (line: string, stdio: 'pipe' | 'ignore' = 'pipe') =>
    spawn('sh', ['-c', command(line)], {
      cwd: home,
      detached: true,
      stdio: [stdio === 'pipe' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    })
  return {
    spawn: spawnHere,
    exec: (line: string, input = '') =>
      new Promise<string>((done, fail) => {
        const child = spawnHere(line)
        let out = ''
        child.stdout!.on('data', (d: Buffer) => (out += d.toString()))
        child.on('close', (code) => (code === 0 ? done(out) : fail(new Error(`exit ${code}`))))
        child.stdin!.end(input)
      }),
  } as unknown as MachineLink
}

const reader = (root: string) => () =>
  spawn(process.execPath, ['--import', 'tsx', join(src, 'preview-sync-reader.ts'), root], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })

async function eventually(check: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return
    await new Promise((done) => setTimeout(done, 50))
  }
  assert.fail(`still not so after 10 s: ${what}`)
}

function write(root: string, path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}

test('the sync sends the checkout, each change, and only what changed after a cut', async () => {
  const root = temp()
  const home = temp()
  execFileSync('git', ['init', '-q', root])
  write(root, '.gitignore', 'dist/\n')
  write(root, 'src/a.ts', 'export const a = 1\n')
  write(root, 'dist/out.js', 'built\n')
  const copy = join(home, 'work/app')
  const lines: string[] = []
  const sync = new MachineSync(fakeLink(home), reader(root), 'work/app', (l) => lines.push(l))
  try {
    assert.equal(await sync.flush(), 2, 'the first flush starts it: two files sent')
    assert.equal(readFileSync(join(copy, 'src/a.ts'), 'utf8'), 'export const a = 1\n')
    assert.ok(!existsSync(join(copy, 'dist')), 'what git ignores stays here')
    assert.ok(
      existsSync(join(home, '.brigade/preview-sync-receiver.mjs')),
      'the receiver was copied',
    )

    write(root, 'src/a.ts', 'export const a = 2\n')
    await eventually(
      () => readFileSync(join(copy, 'src/a.ts'), 'utf8') === 'export const a = 2\n',
      'an edit',
    )
    assert.equal(await sync.flush(), undefined, 'a flush of a running sync sends what changed')

    // Cut (the machine slept); meanwhile one edit. The next flush starts it again.
    sync.stop()
    assert.equal(sync.stopped, true)
    write(root, 'src/b.ts', 'export const b = 1\n')
    assert.equal(await sync.flush(), 1, 'only the new file')
    assert.ok(existsSync(join(copy, 'src/b.ts')))
  } finally {
    sync.stop()
  }
})

/** Passes its input on at 64 KB every 20 ms (about 3 MB a second), and nothing while ./stall exists. */
const SLOW_LINK = `
import { existsSync } from 'node:fs'
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
for await (const chunk of process.stdin)
  for (let at = 0; at < chunk.length; at += 65536) {
    while (existsSync('stall')) await sleep(50)
    if (!process.stdout.write(chunk.subarray(at, at + 65536)))
      await new Promise((done) => process.stdout.once('drain', done))
    await sleep(20)
  }
`

test('a flush waits while bytes go to the machine, however long, and gives up once none do', async () => {
  const root = temp()
  const home = temp()
  execFileSync('git', ['init', '-q', root])
  write(root, 'src/a.ts', 'export const a = 1\n')
  const slow = join(temp(), 'slow-link.mjs')
  writeFileSync(slow, SLOW_LINK)
  const link = fakeLink(home, `node ${shellQuote(slow)} | `)
  const sync = new MachineSync(link, reader(root), 'work/app', () => undefined)
  const staging = join(
    home,
    '.brigade/sync',
    `${createHash('sha256').update('work/app').digest('hex').slice(0, 16)}.staging`,
  )
  try {
    assert.equal(await sync.flush(), 1)
    const clip = randomBytes(8 * 1024 ** 2)
    writeFileSync(join(root, 'clip.mov'), clip)
    // On its way (its bytes staged there as they come): the flush's mark goes after it.
    await eventually(() => readdirSync(staging).length > 0, 'the file on its way')
    const asked = Date.now()
    await sync.flush(1000)
    const took = Date.now() - asked
    assert.ok(took > 1000, `it waited past its second while bytes went: ${took} ms`)
    assert.ok(readFileSync(join(home, 'work/app/clip.mov')).equals(clip))

    // The machine takes nothing more: given up a second after the last byte went.
    writeFileSync(join(home, 'stall'), '')
    await new Promise((done) => setTimeout(done, 100))
    const stalled = Date.now()
    await assert.rejects(sync.flush(1000), /did not confirm the latest changes in time/)
    assert.ok(Date.now() - stalled >= 1000)
  } finally {
    rmSync(join(home, 'stall'), { force: true })
    sync.stop()
  }
})

/**
 * Stands in for the receiver: lacks nothing the manifest names, and acknowledges each mark,
 * naming the files listed in ./partial there as not whole.
 */
const PARTIAL_RECEIVER = `
import { existsSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const say = (message) => process.stdout.write(JSON.stringify(message) + '\\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  let frame
  try { frame = JSON.parse(line) } catch { return }
  if (frame.t === 'manifest') say({ t: 'need', paths: [] })
  if (frame.t !== 'mark') return
  const partial = existsSync('partial') ? readFileSync('partial', 'utf8').split('\\n').filter(Boolean) : []
  say({ t: 'ack', id: frame.id, ...(partial.length ? { partial } : {}) })
})
`

test('a flush fails, naming the file, when the machine has no whole copy of it', async () => {
  const root = temp()
  const home = temp()
  execFileSync('git', ['init', '-q', root])
  write(root, 'src/a.ts', 'export const a = 1\n')
  const stand = join(temp(), 'partial-receiver.mjs')
  writeFileSync(stand, PARTIAL_RECEIVER)
  const sync = new MachineSync(fakeLink(home, '', stand), reader(root), 'work/app', () => undefined)
  try {
    assert.equal(await sync.flush(), 0)
    writeFileSync(join(home, 'partial'), 'footage/clip.mov\n')
    await assert.rejects(
      sync.flush(),
      /The thread’s machine has no whole copy of footage\/clip\.mov yet: it kept changing/,
    )
    rmSync(join(home, 'partial'))
    assert.equal(await sync.flush(), undefined, 'still running: the next flush vouches again')
  } finally {
    sync.stop()
  }
})

test('settings files are sourced by the shell as they were given', () => {
  assert.equal(shellQuote(`it's`), `'it'\\''s'`)
  const text = envFileText({
    PORT: '3000',
    QUOTED: `a 'b' "c" $HOME \`x\``,
    LINES: 'one\ntwo',
    'not-a-name': 'dropped',
  })
  const file = join(temp(), 'env')
  writeFileSync(file, text)
  const env = execFileSync('sh', [
    '-c',
    'set -a; . "$0"; set +a; printf "%s|%s|%s" "$PORT" "$QUOTED" "$LINES"',
    file,
  ]).toString()
  assert.equal(env, `3000|a 'b' "c" $HOME \`x\`|one\ntwo`)
  assert.ok(!text.includes('not-a-name'))
})

test('the app runs with its settings and credentials, its setup only when asked', async () => {
  const home = temp()
  const dir = join(home, 'work/app')
  mkdirSync(dir, { recursive: true })
  const link = fakeLink(home)
  /** Started detached, its output read once it ended there. */
  const output = async () => {
    await startApp(link, 'r1')
    await eventually(async () => (await appState(link))?.state === 'ended', 'it ends')
    return read(readOutput(link, 'r1', 0, false))
  }
  const script = (setup?: string) =>
    remoteScript({
      dir: 'work/app',
      envFiles: 1,
      ...(setup ? { setup } : {}),
      command: 'echo "port=$PORT token=$TOKEN in $(basename "$PWD")"',
      appStarts: '[preview] Starting the app',
    })
  await writeRun(link, { PORT: '4321' }, ['TOKEN=from-the-vault\n'], script('echo setting up'))
  const first = await output()
  assert.match(first, /\[preview\] Running the setup\nsetting up\n\[preview\] Starting the app\n/)
  assert.match(first, /port=4321 token=from-the-vault in app/)
  assert.equal(
    execFileSync('stat', ['-c', '%a', join(home, '.brigade/run/env')])
      .toString()
      .trim(),
    '600',
    'its settings are for its user alone',
  )

  await writeRun(link, { PORT: '4321' }, ['TOKEN=again\n'], script())
  const again = await output()
  assert.doesNotMatch(again, /setup/, 'a restart runs no setup')
  assert.match(again, /token=again/)
})

test('a run never finds an earlier run’s credentials, and none stay once the app stopped', async () => {
  const home = temp()
  const link = fakeLink(home)
  const credential = join(home, '.brigade/run/credentials-0')
  await writeRun(link, {}, ['PRIVATE=first-run-only\n'], 'true\n')
  assert.ok(existsSync(credential))
  // A later run, by a teammate the vault gave nothing to.
  await writeRun(link, {}, [], 'true\n')
  assert.ok(!existsSync(credential), 'the earlier run’s credentials are gone')
  await writeRun(link, { TOKEN: 'x' }, ['PRIVATE=again\n'], 'true\n')
  await clearRun(link)
  assert.ok(!existsSync(credential))
  assert.ok(!existsSync(join(home, '.brigade/run/env')))
})

test('a signal reaches the app’s whole process group, what it started included', async () => {
  const home = temp()
  mkdirSync(join(home, 'work/app'), { recursive: true })
  const link = fakeLink(home)
  await writeRun(
    link,
    {},
    [],
    remoteScript({
      dir: 'work/app',
      envFiles: 0,
      // A child that would outlive its parent, as a dev server's do.
      command: 'sleep 300 & echo $! > child.pid; wait',
      appStarts: '[preview] Starting the app',
    }),
  )
  await startApp(link, 'r1')
  const childPid = join(home, 'work/app/child.pid')
  await eventually(
    () => existsSync(childPid) && readFileSync(childPid, 'utf8').trim() !== '',
    'the child',
  )
  const pid = Number(readFileSync(childPid, 'utf8'))
  await signalApp(link, 'TERM')
  await eventually(async () => (await appState(link))?.state === 'ended', 'it stopped')
  await eventually(() => {
    try {
      process.kill(pid, 0)
      return false
    } catch {
      return true
    }
  }, 'its child stopped too')
})

/** All a command on the machine prints. */
async function read(child: ChildProcess) {
  let out = ''
  child.stdout!.on('data', (d: Buffer) => (out += d.toString()))
  await new Promise((done) => child.on('close', done))
  return out
}

test('the app outlives the connection that started it; its output is read on from any byte', async () => {
  const home = temp()
  mkdirSync(join(home, 'work/app'), { recursive: true })
  const link = fakeLink(home)
  await writeRun(
    link,
    {},
    [],
    remoteScript({
      dir: 'work/app',
      envFiles: 0,
      command: 'echo first; while [ ! -e go ]; do sleep 0.05; done; echo second; exit 3',
      appStarts: '[preview] Starting the app',
    }),
  )
  await startApp(link, 'r1')
  assert.deepEqual(await appState(link), { state: 'running' }, 'running once started, detached')
  // Followed from the start until cut, as a runner handing over does.
  const follow = readOutput(link, 'r1', 0, true)
  let seen = ''
  follow.stdout!.on('data', (d: Buffer) => (seen += d.toString()))
  await eventually(() => seen === 'first\n', 'its first line')
  follow.kill()
  // The next one reads on from the byte reached: nothing again, nothing missed.
  writeFileSync(join(home, 'work/app/go'), '')
  const rest = readOutput(link, 'r1', Buffer.byteLength(seen), true)
  assert.equal(await read(rest), 'second\n')
  assert.deepEqual(await appState(link), { state: 'ended', code: 3 }, 'how it ended, noted')
})

test('a run left before the machine last started is not running, nor signalled', async () => {
  const home = temp()
  mkdirSync(join(home, '.brigade/run'), { recursive: true })
  const link = fakeLink(home)
  // Its group's number is someone else's by now: a process of this test's, in a group of its own.
  const other = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
  try {
    writeFileSync(join(home, '.brigade/run/app.pid'), String(other.pid))
    writeFileSync(join(home, '.brigade/run/boot'), 'another boot\n')
    assert.deepEqual(await appState(link), { state: 'ended', code: null })
    await signalApp(link, 'TERM')
    await new Promise((done) => setTimeout(done, 200))
    assert.equal(other.exitCode ?? other.signalCode, null, 'that group got no signal')
  } finally {
    other.kill('SIGKILL')
  }
})

test('the app’s output gives back its disk once read, its size and offsets kept', async () => {
  const home = temp()
  mkdirSync(join(home, '.brigade/run'), { recursive: true })
  const link = fakeLink(home)
  const file = join(home, '.brigade/run/output-r1.log')
  writeFileSync(file, 'x'.repeat(64 * 1024) + 'after\n')
  await freeOutput(link, 'r1', 64 * 1024)
  const blocks = Number(execFileSync('stat', ['-c', '%b', file]).toString())
  assert.ok(blocks * 512 <= 8 * 1024, `${blocks} blocks left`)
  assert.equal(
    await read(readOutput(link, 'r1', 64 * 1024, false)),
    'after\n',
    'read on from the same byte',
  )
})

test('giving back the disk of a run’s output never touches the next run’s', async () => {
  const home = temp()
  mkdirSync(join(home, '.brigade/run'), { recursive: true })
  const link = fakeLink(home)
  // A release for run r1 that reaches the machine late, once r2 replaced it (a restart).
  const next = join(home, '.brigade/run/output-r2.log')
  writeFileSync(next, 'x'.repeat(8192) + 'the next run’s first lines\n')
  await freeOutput(link, 'r1', 8192)
  assert.match(readFileSync(next, 'utf8'), /^x{8192}the next run’s first lines\n$/)
  assert.ok(!existsSync(join(home, '.brigade/run/output-r1.log')), 'and none is made for r1')
})
