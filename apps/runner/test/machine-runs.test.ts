import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import type { ThreadAttachmentRef } from '@brigade/contracts'
import type { FilesApi } from '../src/machine-files.js'
import { MachineRuns, outputPath, secretValues, type RunSeat } from '../src/machine-runs.js'
import { shellQuote, type MachineLink } from '../src/preview-machine.js'

// Commands on a thread's machine of its own (machine-runs.ts), with the machine stood in for by a
// folder here and the SSH link by commands run in it, each in a session of its own as sshd's:
// - a command runs in the teammate's copy of its folder there, its output and exit status come
//   back, and the outputs it names come back to the same place here; then the machine is let go,
//   kept a while for the next command;
// - one longer than the call's wait goes on, and machine_run waits for it;
// - a failed one says so, and what it made still comes back;
// - a stop ends it and all it started, what ignores TERM included; so does its time limit;
// - while it runs, the API is told so as busy: the runner's computer stays up;
// - credentials' values are hidden in its output, as written by ThreadCredentials (quotes, keys
//   over several lines), even while the line holding one is still being written, and their files
//   do not stay on the machine;
// - outputs, and the folder it runs in, are inside the working directory, and the whole working
//   directory does not go;
// - its output is followed again after the follow was cut, losing and repeating nothing, even
//   when it ended meanwhile;
// - the runner after this one follows it to its end, outputs included, even when it stopped while
//   they came back; an ended one's output is still there after a restart;
// - two commands of the thread at once share the copy of their folder;
// - the thread's attached files are fetched by the machine itself from the bucket (a server here,
//   the API a function answering with its redirect), checked, and put at the same place as in the
//   teammate's folder, where the command finds them; once: the next command does not fetch them
//   again, nor two at once; one that does not match is left out with a note, and the runner's
//   token never reaches the machine, nor the signed URL a command line there; without a bucket,
//   the API's bytes go over the link;
// - a command run in the attachments folder finds them there without its sync sending them; a
//   copy the teammate changed is as given elsewhere, and stays the sync's in that folder.

const src = join(dirname(fileURLToPath(import.meta.url)), '../src')
/** tsx's loader by its path: the stand-in machine's commands run in a folder without it. */
const tsx = import.meta.resolve('tsx')
const made: string[] = []
const servers: Server[] = []
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
  for (const server of servers) server.close()
})

function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'machine-runs-'))
  made.push(dir)
  return dir
}

function write(root: string, path: string, text: string | Buffer) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}

/**
 * Commands "on the machine" run in `home`, in a session of their own. The sync's receiver copied
 * there is TypeScript in tests: run with tsx instead.
 */
function folderLink(home: string) {
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
  const link = {
    log: [] as string[],
    /** What it ran with spawn. */
    spawned: [] as string[],
    /** All the machine was given: each command line, and what went on each one's stdin. */
    given: [] as string[],
    followers: [] as ChildProcess[],
    /** Called before each exec: a test holds one back. */
    before: undefined as ((line: string) => Promise<void>) | undefined,
    /** A spawn it matches fails once, as ssh does when the connection is lost (255). */
    failOnce: undefined as ((line: string) => boolean) | undefined,
    size: 'test',
    connect: async () => undefined,
    close: () => undefined,
    update: () => undefined,
    alive: async () => true,
    spawn: (line: string, stdio: 'pipe' | 'ignore' = 'pipe') => {
      const fails = link.failOnce?.(line) ?? false
      if (fails) link.failOnce = undefined
      const child = spawnHere(fails ? 'exit 255' : line, stdio)
      link.spawned.push(line)
      link.given.push(line)
      const stdin = child.stdin
      if (stdin) {
        const write = stdin.write.bind(stdin) as (chunk: unknown, ...rest: unknown[]) => boolean
        stdin.write = ((chunk: unknown, ...rest: unknown[]) => {
          link.given.push(String(chunk))
          return write(chunk, ...rest)
        }) as typeof stdin.write
      }
      if (line.includes('tail -c')) link.followers.push(child)
      return child
    },
    exec: async (line: string, input = '') => {
      await link.before?.(line)
      return new Promise<string>((done, fail) => {
        link.log.push(line)
        link.given.push(line, input)
        const child = spawnHere(line)
        let out = ''
        let err = ''
        child.stdout!.on('data', (d: Buffer) => (out += d.toString()))
        child.stderr!.on('data', (d: Buffer) => (err += d.toString()))
        // As MachineLink.exec: what it said on stderr is why it failed.
        child.on('close', (code) =>
          code === 0 ? done(out) : fail(new Error(err.trim() || `exit ${code}`)),
        )
        child.stdin!.on('error', () => undefined)
        child.stdin!.end(input)
      })
    },
  }
  return link
}

const reader = (_seat: RunSeat, _net: unknown, root: string) =>
  spawn(process.execPath, ['--import', 'tsx', join(src, 'preview-sync-reader.ts'), root], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })

function fakeHolds() {
  const calls: string[] = []
  return {
    calls,
    up: async (_sessionId: string, holder: string) => {
      calls.push(`up ${holder}`)
      return {
        machine: { id: 'm', host: 'h', port: 22, user: 'u', hostKey: 'k', size: 'test' },
      }
    },
    release: async (_sessionId: string, holder: string, idleMs = 0) =>
      void calls.push(`release ${holder} ${idleMs}`),
    touches: [] as boolean[],
    async touch(_sessionId: string, busy = false) {
      this.touches.push(busy)
    },
  }
}

/** A teammate's working directory with a checkout in it, a machine, and the runner's commands. */
function setup(options: { files?: ConstructorParameters<typeof MachineRuns>[0]['files'] } = {}) {
  const workDir = temp()
  const machine = temp()
  const runner = temp()
  const app = join(workDir, 'app')
  execFileSync('git', ['init', '-q', app])
  write(app, '.gitignore', 'out/\nreport.txt\n')
  write(app, 'src/a.txt', 'hello\n')
  const link = folderLink(machine)
  const holds = fakeHolds()
  const seat: RunSeat = { sessionId: 's1', teammateId: 't1', workDir }
  const make = () =>
    new MachineRuns({
      holds,
      home: runner,
      stateFile: join(runner, 'machine-runs.json'),
      link: () => link as unknown as MachineLink,
      reader,
      idleMs: 1000,
      touchMs: 200,
      stopGraceMs: 1000,
      ...(options.files ? { files: options.files } : {}),
    })
  const runs = make()
  return { workDir, machine, app, link, holds, seat, make, runs, control: runs.forSeat(seat) }
}

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await new Promise((done) => setTimeout(done, 50))
  }
  assert.fail(`still not so after 10 s: ${what}`)
}

test('a command runs in its copy on the machine; its output, status and outputs come back', async () => {
  const { control, app, machine, holds } = setup()
  const result = await control.run(
    {
      command:
        'cat src/a.txt; mkdir -p out && echo built > out/b.txt; echo made > report.txt; echo said >&2',
      cwd: 'app',
      outputs: ['out', 'report.txt', 'missing.txt'],
    },
    30_000,
  )
  assert.equal(result.status, 'succeeded', JSON.stringify(result))
  assert.equal(result.exitCode, 0)
  assert.match(result.output ?? '', /hello/)
  assert.match(result.output ?? '', /said/)
  assert.equal(readFileSync(join(app, 'out/b.txt'), 'utf8'), 'built\n')
  assert.equal(readFileSync(join(app, 'report.txt'), 'utf8'), 'made\n')
  assert.deepEqual(
    result.files?.map((file) => file.split(' (')[0]),
    ['app/out', 'app/report.txt'],
  )
  assert.ok(result.notes.some((note) => note.includes('Not made: missing.txt')))
  assert.ok(
    result.notes.some((note) => note.startsWith('Sent ')),
    'says the folder went',
  )
  assert.ok(existsSync(join(machine, 'commands/t1/app/src/a.txt')), 'the teammate’s own copy')
  assert.deepEqual(holds.calls, [`up run:${result.id}`, `release run:${result.id} 1000`])
})

test('what came back is not sent to the machine again with the next command', async () => {
  const { control, app } = setup()
  // Not ignored by git, made with a mode of its own: the next sync compares it whole.
  const made = await control.run(
    {
      command: 'mkdir -p data && echo result > data/r.json && chmod 664 data/r.json',
      cwd: 'app',
      outputs: ['data/r.json'],
    },
    30_000,
  )
  assert.equal(made.status, 'succeeded')
  assert.equal(readFileSync(join(app, 'data/r.json'), 'utf8'), 'result\n')
  const next = await control.run({ command: 'cat data/r.json', cwd: 'app' }, 30_000)
  assert.equal(next.status, 'succeeded')
  assert.ok(
    !next.notes.some((note) => note.startsWith('Sent ')),
    `nothing sent: ${JSON.stringify(next.notes)}`,
  )
})

test('a command longer than the wait goes on, and machine_run waits for it', async () => {
  const { control, app } = setup()
  const started = await control.run(
    { command: 'sleep 2; echo late > late.txt; echo finished', cwd: 'app', outputs: ['late.txt'] },
    200,
  )
  assert.ok(['starting', 'running'].includes(started.status), started.status)
  const ended = await control.get(started.id, 30_000)
  assert.equal(ended.status, 'succeeded')
  assert.match(ended.output ?? '', /finished/)
  assert.equal(readFileSync(join(app, 'late.txt'), 'utf8'), 'late\n')
  assert.deepEqual(
    control.list().map((run) => [run.id, run.status]),
    [[started.id, 'succeeded']],
  )
})

test('a failed command says so, and what it made still comes back', async () => {
  const { control, app } = setup()
  const result = await control.run(
    {
      command: 'echo partial > report.txt; echo boom; exit 3',
      cwd: 'app',
      outputs: ['report.txt'],
    },
    30_000,
  )
  assert.equal(result.status, 'failed')
  assert.equal(result.exitCode, 3)
  assert.match(result.output ?? '', /boom/)
  assert.equal(readFileSync(join(app, 'report.txt'), 'utf8'), 'partial\n')
})

/** Whether any process is left in the process group `group`. */
function groupLeft(group: string) {
  try {
    execFileSync('pgrep', ['-g', group])
    return true
  } catch {
    return false
  }
}

test('a stop ends the command and all it started, what ignores TERM included; so does its time limit', async () => {
  const { control, machine } = setup()
  const started = await control.run(
    { command: '(trap "" TERM; sleep 300) & sleep 300; echo never', cwd: 'app' },
    0,
  )
  const pidFile = join(machine, `.brigade/runs/${started.id}/pid`)
  await until(() => existsSync(pidFile) && control.list()[0]?.status === 'running', 'running')
  const group = readFileSync(pidFile, 'utf8').trim()
  assert.ok(groupLeft(group), 'its processes run')
  const stopped = await control.stop(started.id)
  assert.equal(stopped.status, 'stopped')
  assert.doesNotMatch(stopped.output ?? '', /never/)
  assert.ok(!groupLeft(group), 'nothing of it is left')

  const limited = await control.run({ command: 'sleep 300', cwd: 'app', timeoutMs: 1500 }, 30_000)
  assert.equal(limited.status, 'timed_out')
  assert.ok(limited.notes.some((note) => note.includes('time limit')))
})

/** As ThreadCredentials.env writes a value: in single quotes, each ' inside as '\''. */
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

/** Its view, asked again until `check` holds of it. */
async function viewUntil(
  control: ReturnType<MachineRuns['forSeat']>,
  id: string,
  check: (output: string) => boolean,
) {
  for (let i = 0; i < 200; i++) {
    const view = await control.get(id, 0)
    if (check(view.output ?? '')) return view
    await new Promise((done) => setTimeout(done, 50))
  }
  assert.fail(`never so: ${id}`)
}

test('credentials’ values are hidden in its output, as ThreadCredentials writes them, and their files do not stay there', async () => {
  const { control, machine, workDir } = setup()
  const released = join(workDir, 'released.env')
  writeFileSync(
    released,
    `${[
      `export API_TOKEN=${quote("dummy'password-123456")}`,
      `export PRIVATE_KEY=${quote('line-one-of-the-key\nline-two-of-the-key')}`,
      `export SHORT=${quote('ab')}`,
    ].join('\n')}\n`,
  )
  const result = await control.run(
    {
      command: 'echo "token is $API_TOKEN, short is $SHORT"; echo "$PRIVATE_KEY"',
      cwd: 'app',
      envFiles: [released],
    },
    30_000,
  )
  assert.equal(result.status, 'succeeded')
  assert.match(result.output ?? '', /token is ••••••, short is ab/)
  for (const part of ['dummy', 'password', 'line-one', 'line-two'])
    assert.ok(!(result.output ?? '').includes(part), `${part} is hidden: ${result.output}`)
  const left = readdirSync(join(machine, `.brigade/runs/${result.id}`))
  assert.ok(!left.some((file) => file === 'env' || file.startsWith('credentials')), left.join(','))

  // A line still being written, the start of a value in it and its rest to come: never shown.
  const partial = await control.run(
    {
      command: 'printf "token: %s" "${API_TOKEN:0:12}"; sleep 2; printf "%s\\n" "${API_TOKEN:12}"',
      cwd: 'app',
      envFiles: [released],
    },
    0,
  )
  const writing = await viewUntil(control, partial.id, (output) => output.includes('token:'))
  assert.equal(writing.output, 'token: ••••••')
  const whole = await control.get(partial.id, 30_000)
  assert.equal(whole.output, 'token: ••••••')

  assert.deepEqual(
    secretValues(
      `export A=${quote("it's a secret")}\nB="x \\"y\\" z"\nC=abc\n# D=commented-out\nexport D=longer-one\nexport E=${quote('multi\nline value')}\n`,
    ),
    ['multi\nline value', "it's a secret", 'longer-one', 'line value', 'x "y" z'],
  )
})

test('outputs and the folder it runs in are inside the working directory', async () => {
  const { control } = setup()
  for (const outputs of [['../x'], ['/etc/passwd'], ['a/../../x'], ['']])
    await assert.rejects(
      control.run({ command: 'true', cwd: 'app', outputs }, 1000),
      /outputs are paths inside cwd/,
      JSON.stringify(outputs),
    )
  await assert.rejects(control.run({ command: 'true', cwd: '..' }, 1000), /inside your working/)
  await assert.rejects(control.run({ command: 'true', cwd: 'nowhere' }, 1000), /No folder nowhere/)
  // Not a checkout: the whole working directory would go.
  await assert.rejects(control.run({ command: 'true' }, 1000), /Give in cwd the folder/)
  assert.equal(outputPath('dist/'), 'dist')
  assert.equal(outputPath('a/../b'), 'b')
})

test('its output is followed again after the follow was cut, nothing lost or repeated', async () => {
  const { control, link } = setup()
  const started = await control.run(
    { command: 'for i in 1 2 3 4 5 6; do echo line$i; sleep 0.3; done', cwd: 'app' },
    0,
  )
  await until(() => link.followers.length > 0, 'followed')
  await new Promise((done) => setTimeout(done, 600))
  link.followers.at(-1)!.kill('SIGKILL')
  const ended = await control.get(started.id, 30_000)
  assert.equal(ended.status, 'succeeded')
  assert.deepEqual(
    (ended.output ?? '').split('\n').filter((line) => line.startsWith('line')),
    ['line1', 'line2', 'line3', 'line4', 'line5', 'line6'],
  )
})

test('the runner after this one follows a command to its end, its outputs included', async () => {
  const { runs, control, make, seat, app, holds } = setup()
  const started = await control.run(
    { command: 'sleep 2; echo after > after.txt; echo bye', cwd: 'app', outputs: ['after.txt'] },
    0,
  )
  await until(() => control.list()[0]?.status === 'running', 'running')
  runs.detach()
  const next = make()
  next.resume()
  const ended = await next.forSeat(seat).get(started.id, 30_000)
  assert.equal(ended.status, 'succeeded')
  assert.match(ended.output ?? '', /bye/)
  assert.equal(readFileSync(join(app, 'after.txt'), 'utf8'), 'after\n')
  assert.deepEqual(holds.calls, [
    `up run:${started.id}`,
    `up run:${started.id}`,
    `release run:${started.id} 1000`,
  ])
})

test('two commands of the thread at once share the copy of their folder', async () => {
  const { control, link } = setup()
  const [a, b] = await Promise.all([
    control.run({ command: 'echo one', cwd: 'app' }, 30_000),
    control.run({ command: 'echo two', cwd: 'app/src' }, 30_000),
  ])
  assert.equal(a.status, 'succeeded')
  assert.equal(b.status, 'succeeded')
  assert.match(a.output ?? '', /one/)
  assert.match(b.output ?? '', /two/)
  assert.equal(
    link.log.filter((line) => line.includes('preview-sync-receiver.mjs')).length,
    1,
    'one sync of the checkout for both',
  )
})

test('while a command runs, the API hears it busy: the runner’s computer stays up', async () => {
  const { control, holds } = setup()
  const result = await control.run({ command: 'sleep 1', cwd: 'app' }, 30_000)
  assert.equal(result.status, 'succeeded')
  assert.ok(
    holds.touches.length >= 2 && holds.touches.every(Boolean),
    JSON.stringify(holds.touches),
  )
})

test('what it wrote as the follow was cut, the moment it ended, is still read', async () => {
  const { control, link } = setup()
  let slow = false
  link.before = async (line) => {
    // Its status is asked slowly: it ends meanwhile, its last line unread.
    if (slow && line.includes('echo gone')) await new Promise((done) => setTimeout(done, 1500))
  }
  const started = await control.run(
    { command: 'echo before; sleep 1; echo final-error-message; exit 1', cwd: 'app' },
    0,
  )
  await viewUntil(control, started.id, (output) => output.includes('before'))
  slow = true
  link.followers.at(-1)!.kill('SIGKILL')
  const ended = await control.get(started.id, 30_000)
  assert.equal(ended.status, 'failed')
  assert.match(ended.output ?? '', /final-error-message/)
})

test('a read of its last output that fails is tried again before it ends', async () => {
  const { control, link } = setup()
  let slow = false
  link.before = async (line) => {
    if (slow && line.includes('echo gone')) await new Promise((done) => setTimeout(done, 1500))
  }
  const started = await control.run(
    { command: 'echo before; sleep 1; echo final-error-message; exit 1', cwd: 'app' },
    0,
  )
  await viewUntil(control, started.id, (output) => output.includes('before'))
  slow = true
  // The connection is lost for the read of what is left too, once.
  link.failOnce = (line) => line.includes('exec tail -c') && !line.includes(' -f ')
  link.followers.at(-1)!.kill('SIGKILL')
  const ended = await control.get(started.id, 30_000)
  assert.equal(ended.status, 'failed')
  assert.match(ended.output ?? '', /final-error-message/)
  assert.equal(link.failOnce, undefined, 'the read did fail once')
})

test('a runner that stops while the outputs come back leaves them to the next one', async () => {
  const { runs, control, make, seat, app, link } = setup()
  let listing!: () => void
  const listed = new Promise<void>((done) => (listing = done))
  let release!: () => void
  const gate = new Promise<void>((done) => (release = done))
  link.before = async (line) => {
    if (!line.includes('for p in')) return
    listing()
    await gate
    throw new Error('its connection went with the runner')
  }
  const started = await control.run(
    { command: 'echo made > report.txt', cwd: 'app', outputs: ['report.txt'] },
    0,
  )
  await listed
  runs.detach()
  link.before = undefined
  release()
  // What the stopped runner still does once its copy failed is over before the next one reads.
  await new Promise((done) => setTimeout(done, 300))
  const next = make()
  next.resume()
  const ended = await next.forSeat(seat).get(started.id, 30_000)
  assert.equal(ended.status, 'succeeded')
  assert.equal(readFileSync(join(app, 'report.txt'), 'utf8'), 'made\n')
})

test('an ended command’s output is still there for machine_run after a restart', async () => {
  const { runs, control, make, seat } = setup()
  const result = await control.run({ command: 'echo kept-line', cwd: 'app' }, 30_000)
  assert.equal(result.status, 'succeeded')
  runs.detach()
  const again = await make().forSeat(seat).get(result.id, 0)
  assert.equal(again.status, 'succeeded')
  assert.match(again.output ?? '', /kept-line/)
})

const TOKEN = 'runner-token-k3q9z7w2x8'
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

/** A file given to the thread, as its spec says it. */
function attached(
  id: string,
  name: string,
  bytes: Buffer,
  over: Partial<ThreadAttachmentRef> = {},
) {
  return {
    id,
    path: `attachments/${name}`,
    name,
    contentType: 'video/quicktime',
    size: bytes.length,
    sha256: sha256(bytes),
    status: 'ready',
    source: 'upload',
    ...over,
  } satisfies ThreadAttachmentRef
}

/** The bucket: each file at its signed URL only, and who asked for it, with what token. */
async function bucket(files: Record<string, Buffer>) {
  const asked: { id: string; authorization?: string }[] = []
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://bucket')
    const id = url.pathname.split('/').pop() ?? ''
    asked.push({
      id,
      ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
    })
    const bytes = files[id]
    if (!bytes || url.searchParams.get('X-Amz-Signature') !== `signed-${id}`)
      return void res.writeHead(403).end()
    res.writeHead(200, { 'content-length': String(bytes.length) }).end(bytes)
  })
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, asked }
}

/**
 * The API: a file's GET, with the runner's token, answered as with R2, by a redirect to the
 * bucket's signed URL; or, given `bytes`, by the bytes themselves, as without a bucket.
 */
function api(bucketUrl: string, bytes?: Record<string, Buffer>) {
  const calls: { url: string; authorization: string | null; redirect?: string }[] = []
  const files: FilesApi = {
    apiUrl: 'http://api.test',
    token: TOKEN,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      calls.push({
        url,
        authorization: new Headers(init?.headers).get('authorization'),
        ...(init?.redirect ? { redirect: init.redirect } : {}),
      })
      const id = url.split('/').pop() ?? ''
      if (bytes?.[id]) {
        // In pieces, as a stream does.
        const body = bytes[id]
        return new Response(
          new ReadableStream({
            start(controller) {
              for (let at = 0; at < body.length; at += 16 * 1024)
                controller.enqueue(new Uint8Array(body.subarray(at, at + 16 * 1024)))
              controller.close()
            },
          }),
        )
      }
      return new Response(null, {
        status: 302,
        headers: { location: `${bucketUrl}/objects/${id}?X-Amz-Signature=signed-${id}` },
      })
    }) as typeof fetch,
  }
  return { calls, files }
}

test('an attached file is fetched by the machine, checked, and put where the command finds it', async () => {
  const clip = randomBytes(256 * 1024 + 7)
  const ref = attached('clip1', 'clip.mov', clip)
  const store = await bucket({ clip1: clip })
  const fake = api(store.url)
  const { control, machine, workDir } = setup({ files: { of: () => [ref], api: fake.files } })
  // The teammate's own copy, as its turn put it there.
  write(workDir, ref.path, clip)
  const result = await control.run(
    { command: 'sha256sum ../attachments/clip.mov', cwd: 'app' },
    30_000,
  )
  assert.equal(result.status, 'succeeded', JSON.stringify(result))
  assert.match(result.output ?? '', new RegExp(ref.sha256))
  assert.ok(
    result.notes.includes('Fetched 1 attached file (256.0 KB) from storage: attachments/clip.mov'),
    JSON.stringify(result.notes),
  )
  // At the same place in the teammate's copy there as in its folder here.
  assert.deepEqual(readFileSync(join(machine, 'commands/t1/attachments/clip.mov')), clip)
  // The runner asked the API with its token and read the redirect; the machine went to the bucket.
  assert.deepEqual(fake.calls, [
    {
      url: 'http://api.test/runner/attachments/clip1',
      authorization: `Bearer ${TOKEN}`,
      redirect: 'manual',
    },
  ])
  assert.deepEqual(store.asked, [{ id: 'clip1' }])
})

test('an attached file the machine has is not fetched again by the next command', async () => {
  const clip = randomBytes(64 * 1024)
  const ref = attached('clip1', 'clip.mov', clip)
  const store = await bucket({ clip1: clip })
  const fake = api(store.url)
  const { control, link } = setup({ files: { of: () => [ref], api: fake.files } })
  const first = await control.run({ command: 'true', cwd: 'app' }, 30_000)
  assert.ok(first.notes.some((note) => note.startsWith('Fetched 1 attached file')))
  const before = link.log.length
  const next = await control.run({ command: 'wc -c < ../attachments/clip.mov', cwd: 'app' }, 30_000)
  assert.equal(next.status, 'succeeded', JSON.stringify(next))
  assert.match(next.output ?? '', new RegExp(`^${clip.length}$`, 'm'))
  assert.ok(!next.notes.some((note) => note.startsWith('Fetched')), JSON.stringify(next.notes))
  assert.equal(store.asked.length, 1, 'fetched once')
  assert.equal(fake.calls.length, 1, 'the API asked once')
  // Known from the machine's record: not even read whole again to be checked.
  assert.ok(
    !link.log.slice(before).some((line) => line.includes('sha256sum')),
    link.log.slice(before).join('\n'),
  )
})

test('two commands starting at once fetch an attached file once', async () => {
  const clip = randomBytes(64 * 1024)
  const ref = attached('clip1', 'clip.mov', clip)
  const store = await bucket({ clip1: clip })
  const { control } = setup({ files: { of: () => [ref], api: api(store.url).files } })
  const [a, b] = await Promise.all([
    control.run({ command: 'cat ../attachments/clip.mov > /dev/null', cwd: 'app' }, 30_000),
    control.run({ command: 'cat ../../attachments/clip.mov > /dev/null', cwd: 'app/src' }, 30_000),
  ])
  assert.equal(a.status, 'succeeded', JSON.stringify(a))
  assert.equal(b.status, 'succeeded', JSON.stringify(b))
  assert.equal(store.asked.length, 1)
})

test('an attached file whose SHA-256 does not match is left out, with a note; the command runs', async () => {
  const clip = randomBytes(64 * 1024)
  const ref = attached('clip1', 'clip.mov', clip, { sha256: sha256(Buffer.from('another file')) })
  const store = await bucket({ clip1: clip })
  const { control, machine } = setup({ files: { of: () => [ref], api: api(store.url).files } })
  const result = await control.run({ command: 'echo ran', cwd: 'app' }, 30_000)
  assert.equal(result.status, 'succeeded', JSON.stringify(result))
  assert.match(result.output ?? '', /ran/)
  assert.ok(
    result.notes.includes(
      'attachments/clip.mov is not on the machine: its SHA-256 is not the one it was given',
    ),
    JSON.stringify(result.notes),
  )
  assert.ok(!result.notes.some((note) => note.startsWith('Fetched')), JSON.stringify(result.notes))
  assert.equal(store.asked.length, 1)
  assert.ok(!existsSync(join(machine, 'commands/t1/attachments/clip.mov')), 'no file')
  // Nor anything of it on its way.
  assert.deepEqual(readdirSync(join(machine, '.brigade/attachments/tmp')), [])
})

test('the machine is never given the runner’s token, nor the signed URL on a command line', async () => {
  const clip = randomBytes(64 * 1024)
  const ref = attached('clip1', 'clip.mov', clip)
  const store = await bucket({ clip1: clip })
  const fake = api(store.url)
  const { control, link } = setup({ files: { of: () => [ref], api: fake.files } })
  const result = await control.run(
    { command: 'cat ../attachments/clip.mov > /dev/null', cwd: 'app' },
    30_000,
  )
  assert.equal(result.status, 'succeeded', JSON.stringify(result))
  // The token went to the API only.
  assert.deepEqual(
    fake.calls.map((call) => call.authorization),
    [`Bearer ${TOKEN}`],
  )
  const given = link.given.join('\n')
  assert.ok(given.includes('X-Amz-Signature=signed-clip1'), 'the signed URL went, on stdin')
  assert.ok(!given.includes(TOKEN), 'the token never did')
  assert.ok(
    ![...link.log, ...link.spawned].some((line) => line.includes('X-Amz-Signature')),
    'never on a command line, which every process there can read',
  )
})

test('without a bucket, the API’s bytes go to the machine over the link, as they come', async () => {
  const clip = randomBytes(200 * 1024 + 3)
  const ref = attached('clip1', 'clip.mov', clip)
  const store = await bucket({})
  const fake = api(store.url, { clip1: clip })
  const { control, machine, link } = setup({ files: { of: () => [ref], api: fake.files } })
  const result = await control.run(
    { command: 'sha256sum ../attachments/clip.mov', cwd: 'app' },
    30_000,
  )
  assert.equal(result.status, 'succeeded', JSON.stringify(result))
  assert.match(result.output ?? '', new RegExp(ref.sha256))
  assert.ok(result.notes.some((note) => note.startsWith('Fetched 1 attached file')))
  assert.deepEqual(readFileSync(join(machine, 'commands/t1/attachments/clip.mov')), clip)
  assert.equal(store.asked.length, 0)
  assert.ok(
    link.spawned.some((line) => line.includes('cat > "$t"')),
    'streamed to the machine',
  )
  assert.ok(!link.given.join('\n').includes(TOKEN))
})

test('a command run in the attachments folder finds its files there, and its sync does not send them', async () => {
  const clip = randomBytes(96 * 1024)
  const ref = attached('clip1', 'clip.mov', clip)
  const store = await bucket({ clip1: clip })
  const { control, machine, workDir } = setup({
    files: { of: () => [ref], api: api(store.url).files },
  })
  // The teammate's copy as given, with a mode and a time of its own (to the millisecond).
  write(workDir, ref.path, clip)
  chmodSync(join(workDir, ref.path), 0o600)
  utimesSync(join(workDir, ref.path), new Date(1_700_000_000_123), new Date(1_700_000_000_123))
  const result = await control.run({ command: 'sha256sum clip.mov', cwd: 'attachments' }, 30_000)
  assert.equal(result.status, 'succeeded', JSON.stringify(result))
  assert.match(result.output ?? '', new RegExp(ref.sha256))
  assert.ok(result.notes.some((note) => note.startsWith('Fetched 1 attached file')))
  // Fetched from storage, the sync finding it there as the teammate's copy is: nothing sent.
  assert.ok(!result.notes.some((note) => note.startsWith('Sent ')), JSON.stringify(result.notes))
  assert.equal(store.asked.length, 1)
  const placed = statSync(join(machine, 'commands/t1/attachments/clip.mov'))
  assert.equal(placed.mode & 0o777, 0o600)
  assert.equal(Math.trunc(placed.mtimeMs), 1_700_000_000_123)
})

test('a copy the teammate changed: commands get the file as given, but the sync’s copy stays in a folder it sends', async () => {
  const clip = randomBytes(64 * 1024)
  const ref = attached('clip1', 'clip.mov', clip)
  const store = await bucket({ clip1: clip })
  const { control, workDir } = setup({ files: { of: () => [ref], api: api(store.url).files } })
  // Edited here since it was given: longer now.
  write(workDir, ref.path, Buffer.concat([clip, Buffer.from('edited')]))
  const edited = sha256(readFileSync(join(workDir, ref.path)))
  const beside = await control.run(
    { command: 'sha256sum ../attachments/clip.mov', cwd: 'app' },
    30_000,
  )
  assert.equal(beside.status, 'succeeded', JSON.stringify(beside))
  assert.match(beside.output ?? '', new RegExp(ref.sha256), 'the file as given')
  // Run in the attachments folder, which the sync sends as it is here: the edited copy, each time.
  for (let i = 0; i < 2; i++) {
    const inside = await control.run({ command: 'sha256sum clip.mov', cwd: 'attachments' }, 30_000)
    assert.equal(inside.status, 'succeeded', JSON.stringify(inside))
    assert.match(inside.output ?? '', new RegExp(edited), 'the folder as it is here')
  }
  // Fetched once: the sync's copy is not fetched over again, only for the sync to send it again.
  assert.equal(store.asked.length, 1)
})
