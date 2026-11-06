import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { after, test } from 'node:test'
import { Reader } from '../src/preview-sync-reader.js'
import { Receiver, safePath } from '../src/preview-sync-receiver.js'

// A preview machine's sync (preview-sync-reader.ts → preview-sync-receiver.ts), both halves in
// this process with a pipe between them as SSH would be:
// - the whole checkout goes the first time, but not .git, node_modules, nor what git ignores,
//   except .env files and the paths the start names (its env file);
// - each change goes as it happens: edits, new folders, deletions, renames, a file that became
//   a folder; a new ignored file does not;
// - what the machine made itself (dependencies, its database) is never touched;
// - after a cut, a new reader sends only what changed meanwhile, and deletes what went;
// - what the machine asks for is sent only when it is in the reader's own manifest, and never
//   read through a link out of the checkout: code on the machine cannot fetch other files;
// - a file up to 2 GB goes, one over 8 MB a chunk at a time as the pipe takes them, never whole
//   in it; one cut short on the way, or grown, still ends up there as it is here; one over 2 GB
//   is left out, and goes from the machine;
// - the receiver drops the bytes of a path it refuses, and applies the frame after them; what it
//   stages (outside the copy) never stays there.

const made: string[] = []
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'preview-sync-'))
  made.push(dir)
  return dir
}

function write(root: string, path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}

/** Resolves once `check` holds, asking every 50 ms for up to 10 s. */
async function eventually(check: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await new Promise((done) => setTimeout(done, 50))
  }
  assert.fail(`still not so after 10 s: ${what}`)
}

/** A checkout with what a preview's sync meets: ignored builds, env files, a link, a script. */
function checkout() {
  const root = temp()
  execFileSync('git', ['init', '-q', root])
  write(root, '.gitignore', 'dist/\n*.log\n.preview/\n.env\nconfig/app.vars\n')
  write(root, 'src/a.ts', 'export const a = 1\n')
  write(root, 'README.md', '# Hello\n')
  write(root, 'nested/deep/file.txt', 'deep\n')
  write(root, 'dist/out.js', 'built\n')
  write(root, 'app.log', 'noise\n')
  write(root, 'node_modules/x/index.js', 'module.exports = 1\n')
  write(root, '.env', 'SECRET=1\n')
  write(root, 'config/app.vars', 'PORT=3000\n')
  write(root, 'run.sh', '#!/bin/sh\necho hi\n')
  chmodSync(join(root, 'run.sh'), 0o755)
  symlinkSync('src/a.ts', join(root, 'link.ts'))
  return root
}

/** A hold: once `after` bytes of the file at `path` went, the receiver takes nothing until released. */
type Hold = { path: string; after?: number; reached: () => void; released: Promise<void> }

/**
 * The two halves joined by a pipe; `flush` resolves once the receiver says all is written. The
 * receiver takes each chunk before the next, as on the machine, so the reader waits for it;
 * `slow`: it takes them slowly, so that a reader that did not wait would fill the pipe.
 */
function pair(root: string, copy: string, state: string, include: string[] = [], slow = false) {
  const pipe = new PassThrough()
  const acks = new Map<number, () => void>()
  const errors: string[] = []
  const warnings: string[] = []
  let needed!: (paths: string[]) => void
  const need = new Promise<string[]>((done) => (needed = done))
  // eslint-disable-next-line prefer-const
  let reader: Reader
  const receiver = new Receiver(copy, state, (message) => {
    const m = message as { t: string; id?: number; paths?: string[]; message?: string }
    if (m.t === 'need') {
      void reader.answerNeed(m.paths!)
      needed(m.paths!)
    } else if (m.t === 'ack') acks.get(m.id!)?.()
    else if (m.t === 'error') errors.push(m.message!)
  })
  /** The most bytes the pipe held at once (with the chunk being taken). */
  const flow = { most: 0 }
  let hold: Hold | undefined
  void (async () => {
    for await (const data of pipe as AsyncIterable<Buffer>) {
      flow.most = Math.max(flow.most, data.length + pipe.readableLength + pipe.writableLength)
      if (hold?.after === undefined) {
        if (hold && data.includes(`"p":${JSON.stringify(hold.path)}`)) hold.after = 2 * 1024 ** 2
      } else if (hold.after > 0) hold.after -= data.length
      else {
        hold.reached()
        await hold.released
        hold = undefined
      }
      await receiver.push(data)
      if (slow) await new Promise((done) => setTimeout(done, 1))
    }
  })()
  reader = new Reader(root, pipe, { include, warn: (line) => warnings.push(line) })
  let marks = 0
  return {
    reader,
    receiver,
    errors,
    warnings,
    need,
    flow,
    /**
     * Once about 2 MB of the file at `path` went, the receiver takes nothing more, the reader
     * held mid-file, until `release`.
     */
    holdIn(path: string) {
      let reached!: () => void
      let release!: () => void
      const there = new Promise<void>((done) => (reached = done))
      hold = { path, reached, released: new Promise((done) => (release = done)) }
      return { there, release }
    },
    async flush() {
      const id = ++marks
      const acked = new Promise<void>((done) => acks.set(id, done))
      await reader.flush(id)
      await acked
    },
    /** Started, its first sync written: the paths the receiver asked for. */
    async start() {
      await reader.start()
      const paths = await need
      await this.flush()
      return paths
    },
  }
}

const text = (root: string, path: string) => readFileSync(join(root, path), 'utf8')
const there = (root: string, path: string) => existsSync(join(root, path))

/** A file of random bytes, written a piece at a time: its SHA-256. */
function randomFile(path: string, size: number) {
  mkdirSync(dirname(path), { recursive: true })
  const hash = createHash('sha256')
  const fd = openSync(path, 'w')
  for (let at = 0; at < size;) {
    const piece = randomBytes(Math.min(3 * 1024 ** 2 + 17, size - at))
    writeSync(fd, piece)
    hash.update(piece)
    at += piece.length
  }
  closeSync(fd)
  return hash.digest('hex')
}

/** A file's SHA-256, read a piece at a time. */
function hashOf(path: string) {
  const hash = createHash('sha256')
  const fd = openSync(path, 'r')
  const piece = Buffer.alloc(4 * 1024 ** 2)
  for (let read; (read = readSync(fd, piece)) > 0;) hash.update(piece.subarray(0, read))
  closeSync(fd)
  return hash.digest('hex')
}

/** One frame as the reader writes it: its header line, then its body. */
const frame = (header: object, body = Buffer.alloc(0)) =>
  Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), body])

test('the first sync sends the checkout, not what git ignores, and leaves the machine’s own files', async () => {
  const root = checkout()
  const copy = temp()
  write(copy, 'node_modules/y.js', 'installed on the machine\n')
  write(copy, '.preview/db', 'the preview’s database\n')
  const sync = pair(root, copy, join(temp(), 'state.json'), ['config/app.vars'])
  const needed = await sync.start()
  sync.reader.close()

  assert.deepEqual(needed.sort(), [
    '.env',
    '.gitignore',
    'README.md',
    'config/app.vars',
    'link.ts',
    'nested/deep/file.txt',
    'run.sh',
    'src/a.ts',
  ])
  assert.equal(text(copy, 'src/a.ts'), 'export const a = 1\n')
  assert.equal(text(copy, '.env'), 'SECRET=1\n', '.env goes though git ignores it')
  assert.equal(
    text(copy, 'config/app.vars'),
    'PORT=3000\n',
    'the env file the start names goes too',
  )
  assert.equal(readlinkSync(join(copy, 'link.ts')), 'src/a.ts', 'a link stays a link')
  assert.equal(lstatSync(join(copy, 'run.sh')).mode & 0o777, 0o755, 'a script stays runnable')
  assert.equal(
    Math.trunc(lstatSync(join(copy, 'src/a.ts')).mtimeMs),
    Math.trunc(lstatSync(join(root, 'src/a.ts')).mtimeMs),
    'with its time, so the next sync knows it has it',
  )
  for (const path of ['dist/out.js', 'app.log', 'node_modules/x/index.js', '.git'])
    assert.ok(!there(copy, path), `${path} is not sent`)
  assert.equal(text(copy, 'node_modules/y.js'), 'installed on the machine\n')
  assert.equal(text(copy, '.preview/db'), 'the preview’s database\n')
  assert.deepEqual(sync.errors, [])
})

test('each change goes as it happens; a new ignored file does not', async () => {
  const root = checkout()
  const copy = temp()
  const sync = pair(root, copy, join(temp(), 'state.json'))
  await sync.start()
  try {
    write(root, 'src/a.ts', 'export const a = 2\n')
    await eventually(() => text(copy, 'src/a.ts') === 'export const a = 2\n', 'an edit')

    write(root, 'fresh/inner/b.ts', 'export const b = 1\n')
    await eventually(() => there(copy, 'fresh/inner/b.ts'), 'a file in a new folder')

    rmSync(join(root, 'README.md'))
    await eventually(() => !there(copy, 'README.md'), 'a deleted file')

    renameSync(join(root, 'nested'), join(root, 'moved'))
    await eventually(
      () => there(copy, 'moved/deep/file.txt') && !there(copy, 'nested'),
      'a renamed folder, and the old one gone',
    )

    write(root, '.env.local', 'LOCAL=1\n')
    await eventually(() => there(copy, '.env.local'), 'a new env file')

    // A file that becomes a folder.
    write(root, 'thing', 'a file\n')
    await eventually(() => there(copy, 'thing'), 'the file')
    rmSync(join(root, 'thing'))
    write(root, 'thing/inner.txt', 'now a folder\n')
    await eventually(() => there(copy, 'thing/inner.txt'), 'the folder in its place')

    write(root, 'dist/new.js', 'built again\n')
    write(root, 'marker.txt', 'after it\n')
    await eventually(() => there(copy, 'marker.txt'), 'a change after the ignored one')
    await sync.flush()
    assert.ok(!there(copy, 'dist/new.js'), 'a new ignored file is not sent')
    assert.deepEqual(sync.errors, [])
  } finally {
    sync.reader.close()
  }
})

test('after a cut, only what changed meanwhile goes, and what went is deleted', async () => {
  const root = checkout()
  const copy = temp()
  const state = join(temp(), 'state.json')
  const first = pair(root, copy, state)
  await first.start()
  first.reader.close()
  write(copy, 'node_modules/y.js', 'installed on the machine\n')

  // Meanwhile, here: one edit, one deletion, one new file.
  write(root, 'src/a.ts', 'export const a = 3\n')
  rmSync(join(root, 'README.md'))
  write(root, 'src/c.ts', 'export const c = 1\n')

  const again = pair(root, copy, state)
  const needed = await again.start()
  again.reader.close()
  assert.deepEqual(needed.sort(), ['src/a.ts', 'src/c.ts'])
  assert.equal(text(copy, 'src/a.ts'), 'export const a = 3\n')
  assert.ok(there(copy, 'src/c.ts'))
  assert.ok(!there(copy, 'README.md'), 'deleted there too')
  assert.equal(text(copy, 'node_modules/y.js'), 'installed on the machine\n', 'never sent: kept')
})

test('the machine gets only what the manifest has, never a file out of the checkout', async () => {
  const home = temp()
  const root = join(home, 'checkout')
  mkdirSync(root)
  execFileSync('git', ['init', '-q', root])
  write(root, 'src/a.ts', 'export const a = 1\n')
  write(root, 'node_modules/x/index.js', 'never sent\n')
  write(home, 'outside.env', 'OUTSIDE_ONLY\n')
  write(home, 'elsewhere/a.ts', 'OUTSIDE_ONLY\n')
  const out = new PassThrough()
  const sent: Buffer[] = []
  out.on('data', (d: Buffer) => sent.push(d))
  const reader = new Reader(root, out, { warn: () => undefined })
  try {
    await reader.start()
    await reader.answerNeed(['../outside.env', '/etc/passwd', 'node_modules/x/index.js', 42])
    // A folder of the manifest that became a link to elsewhere: its file is not read there.
    rmSync(join(root, 'src'), { recursive: true })
    symlinkSync(join(home, 'elsewhere'), join(root, 'src'))
    await reader.answerNeed(['src/a.ts'])
    await reader.flush(1)
  } finally {
    reader.close()
  }
  const text = Buffer.concat(sent).toString()
  assert.ok(!text.includes('OUTSIDE_ONLY'), 'nothing from outside the checkout')
  assert.ok(!text.includes('never sent'))
})

test('a path git refuses does not make the reader send what git ignores', async () => {
  const root = temp()
  execFileSync('git', ['init', '-q', root])
  write(root, '.gitignore', 'dist/\n')
  write(root, 'src/a.ts', 'export const a = 1\n')
  const copy = temp()
  const sync = pair(root, copy, join(temp(), 'state.json'))
  await sync.start()
  try {
    // git's check-ignore stops for good at a path outside the repository (a file that exists).
    const outside = `${root}-outside`
    writeFileSync(outside, 'OUTSIDE_ONLY\n')
    made.push(outside)
    await sync.reader.answerNeed([`../${outside.split('/').pop()}`])
    await new Promise((done) => setTimeout(done, 300))
    write(root, 'dist/built.js', 'IGNORED_BUILD\n')
    write(root, 'src/b.ts', 'export const b = 1\n')
    await eventually(() => there(copy, 'src/b.ts'), 'a change after it')
    await sync.flush()
    assert.ok(!there(copy, 'dist/built.js'), 'what git ignores is still left out')
    assert.ok(!readdirSync(dirname(copy)).some((f) => f.endsWith('-outside') && there(copy, f)))
  } finally {
    sync.reader.close()
  }
})

test('the receiver writes only inside its copy', () => {
  for (const bad of ['', '../x', '/etc/passwd', 'a/../b', 'a//b', './a', 'a\\b', 'a\0b'])
    assert.equal(safePath(bad), false, JSON.stringify(bad))
  for (const good of ['a', 'a/b.ts', '.env', 'x/.gitignore'])
    assert.equal(safePath(good), true, good)
})

const MB = 1024 ** 2

test('a file over 100 MB arrives byte for byte, a chunk at a time, never whole in the pipe', async () => {
  const root = checkout()
  const copy = temp()
  // Past the old limit, and not a whole number of chunks.
  const size = 103 * MB + 5
  const sha = randomFile(join(root, 'footage/clip.mov'), size)
  const sync = pair(root, copy, join(temp(), 'state.json'), [], true)
  const needed = await sync.start()
  sync.reader.close()

  assert.ok(needed.includes('footage/clip.mov'))
  assert.equal(statSync(join(copy, 'footage/clip.mov')).size, size)
  assert.equal(hashOf(join(copy, 'footage/clip.mov')), sha, 'the same bytes')
  // The chunk being taken, and a header line: the reader waits for the pipe to take each.
  assert.ok(sync.flow.most <= 2 * MB, `the pipe held ${sync.flow.most} bytes at once`)
  assert.deepEqual(sync.errors, [])
  assert.deepEqual(readdirSync(sync.receiver.staging), [], 'nothing stays staged')
})

test('a file cut short while it goes ends up there as it is here', async () => {
  const root = checkout()
  const copy = temp()
  const outside = temp()
  const sync = pair(root, copy, join(temp(), 'state.json'))
  await sync.start()
  try {
    const held = sync.holdIn('clip.mov')
    randomFile(join(root, 'clip.mov'), 12 * MB)
    // Another name for the same file, out of the checkout: what is written through it reaches
    // no watcher of the reader's, which finds out only as it reads.
    linkSync(join(root, 'clip.mov'), join(outside, 'clip.mov'))
    await held.there
    const now = 'cut short, then written again\n'
    writeFileSync(join(outside, 'clip.mov'), now)
    held.release()

    const copied = join(copy, 'clip.mov')
    await eventually(
      () =>
        existsSync(copied) &&
        statSync(copied).size === now.length &&
        text(copy, 'clip.mov') === now,
      'the file as it is here',
    )
    await sync.flush()
    assert.equal(text(copy, 'clip.mov'), now)
    assert.deepEqual(sync.errors, [])
    assert.deepEqual(readdirSync(sync.receiver.staging), [])
  } finally {
    sync.reader.close()
  }
})

test('a file that grows while it goes is sent as its header said, then as it is', async () => {
  const root = checkout()
  const copy = temp()
  const sync = pair(root, copy, join(temp(), 'state.json'))
  await sync.start()
  try {
    const held = sync.holdIn('clip.mov')
    randomFile(join(root, 'clip.mov'), 12 * MB)
    await held.there
    appendFileSync(join(root, 'clip.mov'), randomBytes(3 * MB + 1))
    const sha = hashOf(join(root, 'clip.mov'))
    held.release()

    const copied = join(copy, 'clip.mov')
    await eventually(
      () => existsSync(copied) && statSync(copied).size === 15 * MB + 1,
      'the file grown',
    )
    await sync.flush()
    assert.equal(hashOf(copied), sha)
    assert.deepEqual(sync.errors, [])
  } finally {
    sync.reader.close()
  }
})

test('a file over 2 GB is left out, said once, and goes from the machine', async () => {
  const root = checkout()
  write(root, 'footage/long.mov', 'a short take\n')
  const copy = temp()
  const sync = pair(root, copy, join(temp(), 'state.json'))
  await sync.start()
  try {
    assert.equal(text(copy, 'footage/long.mov'), 'a short take\n')
    // Grown past the limit; sparse, so it takes no room here.
    truncateSync(join(root, 'footage/long.mov'), 2 * 1024 ** 3 + 1)
    await eventually(() => !there(copy, 'footage/long.mov'), 'gone from the machine')
    appendFileSync(join(root, 'footage/long.mov'), 'more')
    write(root, 'marker.txt', 'after it\n')
    await eventually(() => there(copy, 'marker.txt'), 'a change after it')
    await sync.flush()
    assert.ok(!there(copy, 'footage/long.mov'))
    assert.deepEqual(sync.warnings, [
      "[preview] footage/long.mov is not sent to the thread's machine: over 2 GB",
    ])
    assert.deepEqual(sync.errors, [])
  } finally {
    sync.reader.close()
  }
})

test('the receiver drops the bytes of a path it refuses, and applies the frame after them', async () => {
  const copy = join(temp(), 'copy')
  mkdirSync(copy)
  const said: object[] = []
  const receiver = new Receiver(copy, join(temp(), 'state.json'), (m) => said.push(m))
  // Its bytes read as a frame would write planted.txt.
  const planted = frame(
    { t: 'file', p: 'planted.txt', s: 6, m: 0o644, mt: 0 },
    Buffer.from('EVIL!\n'),
  )
  await receiver.push(frame({ t: 'file', p: '../outside.txt', s: planted.length, m: 0o644, mt: 0 }))
  assert.deepEqual(
    said,
    [{ t: 'error', message: 'A path outside the copy' }],
    'refused on its header, before any of its bytes',
  )
  const rest = Buffer.concat([
    planted,
    frame({ t: 'file', p: 'empty.txt', s: 0, m: 0o644, mt: 0 }),
    frame(
      { t: 'file', p: 'after.txt', s: 6, m: 0o640, mt: 1_700_000_000_000 },
      Buffer.from('after\n'),
    ),
    frame({ t: 'mark', id: 1 }),
  ])
  // In pieces, as a pipe may cut them.
  for (let at = 0; at < rest.length; at += 5) await receiver.push(rest.subarray(at, at + 5))
  await receiver.idle()

  assert.equal(text(copy, 'empty.txt'), '', 'a file of no bytes too')
  assert.equal(text(copy, 'after.txt'), 'after\n')
  assert.equal(lstatSync(join(copy, 'after.txt')).mode & 0o777, 0o640)
  assert.equal(Math.trunc(lstatSync(join(copy, 'after.txt')).mtimeMs), 1_700_000_000_000)
  assert.ok(!there(copy, 'planted.txt'), 'its bytes were not read as a frame')
  assert.ok(!existsSync(join(dirname(copy), 'outside.txt')))
  assert.deepEqual(said.slice(1), [{ t: 'ack', id: 1 }])
  assert.deepEqual(readdirSync(receiver.staging), [])
})

test('nothing stays staged: what an earlier receiver left, a file cut by the link’s end, one it could not place', async () => {
  const stateDir = temp()
  const state = join(stateDir, 'state.json')
  const staging = join(stateDir, 'state.staging')
  write(staging, 'a1b2c3.part', 'half a file, from a receiver that stopped short')
  const copy = temp()
  const said: { t: string; message?: string }[] = []
  const say = (m: object) => said.push(m as (typeof said)[number])

  const first = new Receiver(copy, state, say)
  assert.equal(first.staging, staging, 'beside the state file')
  assert.deepEqual(readdirSync(staging), [], 'emptied as it starts')
  // The link is cut a megabyte into a file of ten: its bytes were staged as they came, and go.
  await first.push(frame({ t: 'file', p: 'cut.mov', s: 10 * MB, m: 0o644, mt: 0 }, randomBytes(MB)))
  const parts = readdirSync(staging)
  assert.equal(parts.length, 1)
  // Taken once written: what feeds it waits for the disk, rather than its memory filling up.
  assert.equal(statSync(join(staging, parts[0]!)).size, MB, 'staged as they came')
  await first.end()
  await first.idle()
  assert.deepEqual(readdirSync(staging), [])
  assert.ok(!there(copy, 'cut.mov'), 'never placed')

  // A folder it cannot write in (only as another user than root: root writes anywhere).
  if (process.getuid?.() !== 0) {
    const second = new Receiver(copy, state, say)
    mkdirSync(join(copy, 'locked'))
    chmodSync(join(copy, 'locked'), 0o500)
    try {
      await second.push(
        frame({ t: 'file', p: 'locked/x.txt', s: 3, m: 0o644, mt: 0 }, Buffer.from('abc')),
      )
      await second.idle()
    } finally {
      chmodSync(join(copy, 'locked'), 0o700)
    }
    assert.ok(said.some((m) => m.t === 'error' && /EACCES/.test(m.message ?? '')))
    assert.ok(!there(copy, 'locked/x.txt'))
    assert.deepEqual(readdirSync(staging), [])
  }
})

test('staged on another filesystem than the copy, a file is copied in place whole', async (t) => {
  const copy = temp()
  if (!existsSync('/dev/shm') || statSync('/dev/shm').dev === statSync(copy).dev)
    return t.skip('no other filesystem at /dev/shm')
  const staging = mkdtempSync('/dev/shm/preview-sync-')
  made.push(staging)
  const said: object[] = []
  const receiver = new Receiver(copy, join(temp(), 'state.json'), (m) => said.push(m), staging)
  const body = randomBytes(MB + 3)
  await receiver.push(
    Buffer.concat([
      frame(
        { t: 'file', p: 'deep/clip.mov', s: body.length, m: 0o600, mt: 1_700_000_000_000 },
        body,
      ),
      frame({ t: 'mark', id: 1 }),
    ]),
  )
  await receiver.idle()
  assert.deepEqual(said, [{ t: 'ack', id: 1 }])
  assert.ok(readFileSync(join(copy, 'deep/clip.mov')).equals(body))
  assert.equal(lstatSync(join(copy, 'deep/clip.mov')).mode & 0o777, 0o600)
  assert.equal(Math.trunc(lstatSync(join(copy, 'deep/clip.mov')).mtimeMs), 1_700_000_000_000)
  assert.deepEqual(readdirSync(staging), [])
  assert.deepEqual(readdirSync(join(copy, 'deep')), ['clip.mov'], 'nothing else beside it')
})
