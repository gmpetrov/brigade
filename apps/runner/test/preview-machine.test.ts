import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import {
  envFileText,
  MachineSync,
  remoteScript,
  runApp,
  shellQuote,
  signalApp,
  writeRun,
  type MachineLink,
} from '../src/preview-machine.js'

// A preview on a machine of its own, from the runner's side (preview-machine.ts), with a stand-in
// for the SSH link that runs each command in a folder here, as the machine's home:
// - the sync starts the reader here and the receiver there, sends the whole checkout, then
//   each change, and starts again after it was cut, sending only what changed;
// - the app's script sources its settings and credentials, runs the setup only when asked, and
//   its whole process group stops when signalled, what it left included.

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
 * receiver copied there is TypeScript in tests: run with tsx instead.
 */
function fakeLink(home: string) {
  const command = (line: string) =>
    line.replace(
      'node .brigade/preview-sync-receiver.mjs',
      `node --import ${shellQuote(tsx)} ${shellQuote(join(src, 'preview-sync-receiver.ts'))}`,
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

async function eventually(check: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (check()) return
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
  const output = async (child: ChildProcess) => {
    let out = ''
    child.stdout!.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr!.on('data', (d: Buffer) => (out += d.toString()))
    await new Promise((done) => child.on('close', done))
    return out
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
  const first = await output(runApp(link))
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
  const again = await output(runApp(link))
  assert.doesNotMatch(again, /setup/, 'a restart runs no setup')
  assert.match(again, /token=again/)
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
  const app = runApp(link)
  const childPid = join(home, 'work/app/child.pid')
  await eventually(
    () => existsSync(childPid) && readFileSync(childPid, 'utf8').trim() !== '',
    'the child',
  )
  const pid = Number(readFileSync(childPid, 'utf8'))
  const exited = new Promise((done) => app.on('close', done))
  await signalApp(link, 'TERM')
  await exited
  await eventually(() => {
    try {
      process.kill(pid, 0)
      return false
    } catch {
      return true
    }
  }, 'its child stopped too')
})
