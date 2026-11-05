import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
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
// - after a cut, a new reader sends only what changed meanwhile, and deletes what went.

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

/** The two halves joined by a pipe; `flush` resolves once the receiver says all is written. */
function pair(root: string, copy: string, state: string, include: string[] = []) {
  const pipe = new PassThrough()
  const acks = new Map<number, () => void>()
  const errors: string[] = []
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
  pipe.on('data', (data: Buffer) => receiver.push(data))
  reader = new Reader(root, pipe, { include, warn: () => undefined })
  let marks = 0
  return {
    reader,
    errors,
    need,
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

test('the receiver writes only inside its copy', () => {
  for (const bad of ['', '../x', '/etc/passwd', 'a/../b', 'a//b', './a', 'a\\b', 'a\0b'])
    assert.equal(safePath(bad), false, JSON.stringify(bad))
  for (const good of ['a', 'a/b.ts', '.env', 'x/.gitignore'])
    assert.equal(safePath(good), true, good)
})
