// The sending half of a preview machine's sync (docs/previews.md, preview-machine.ts): run as the
// teammate, in its thread's namespaces, so it reads the checkout as the app would. It says what
// the checkout holds (a manifest), sends the files the machine asks for, then watches the
// checkout and sends each change as it happens. One way only: nothing comes back into the
// checkout. Only node: modules, so it runs as a file of its own.
//
//   node preview-sync-reader.js <root> [--include <path>]...
//
// stdout: frames for the receiver (preview-sync-receiver.ts), each a JSON line, then for a file
// exactly the bytes its line says. A file goes up to 2 GB (raw footage for a render): one over
// 8 MB is read a chunk at a time from one open file as the stream takes them, never whole in
// memory. stdin: JSON lines from the runner: the paths the receiver needs, a flush (send what
// changed now, then a mark the receiver acknowledges) or a resync (the manifest again, after the
// link to the machine was cut). Left out: .git and node_modules anywhere, and whatever git
// ignores (builds, caches, the preview's own database), except .env files, which the app reads.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { constants, watch, type FSWatcher, type Stats } from 'node:fs'
import { lstat, open, readdir, readlink, realpath, type FileHandle } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { createInterface } from 'node:readline'

/** Never sent, wherever they are: git's own files, and dependencies the machine installs. */
const SKIPPED = new Set(['.git', 'node_modules'])
/** Sent even when git ignores them: the app's own settings (.env, .env.local…). */
const ENV_FILE = /^\.env(\..+)?$/
/** A file larger than this is not sent, nor kept on the machine: said once on stderr. */
const FILE_MAX = 2 * 1024 ** 3
/** A file larger than this goes a chunk at a time, read as the stream takes them. */
const STREAM_MIN = 8 * 1024 ** 2
/** The chunks a large file goes in. */
const CHUNK = 1024 ** 2
/** Changes this close together go as one batch. */
const BATCH_MS = 15

type Entry = { size: number; mtimeMs: number; mode: number } | { link: string }
/** Bytes for the stream: resolves once it took them. */
type Write = (chunk: Buffer) => Promise<void>

/** A path relative to the root, with / between its parts whatever the system's separator. */
const rel = (...parts: string[]) => parts.filter(Boolean).join('/')
const skipped = (path: string) => path.split('/').some((part) => SKIPPED.has(part))
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/**
 * Whether git ignores paths, asked of one `git check-ignore --stdin` that answers each path as
 * it comes. Tracked files are never ignored. Outside a git work tree, nothing is.
 */
/** One `git check-ignore --stdin`, with the answers it still owes, in order. */
type Checker = {
  git: ChildProcessWithoutNullStreams
  waiting: ((ignored: boolean) => void)[]
  fields: string[]
  partial: string
}

class Ignores {
  private checker?: Checker
  private inside = false

  /** `included`: paths sent even when git ignores them (the app's env file). */
  constructor(
    private readonly root: string,
    private readonly included: Set<string> = new Set(),
  ) {}

  async start() {
    this.inside = await new Promise<boolean>((done) => {
      const probe = spawn('git', ['-C', this.root, 'rev-parse', '--is-inside-work-tree'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      let out = ''
      probe.stdout.on('data', (d: Buffer) => (out += d.toString()))
      probe.on('error', () => done(false))
      probe.on('close', (code) => done(code === 0 && out.trim() === 'true'))
    })
    if (this.inside) this.open()
  }

  private open() {
    const git = spawn('git', ['-C', this.root, 'check-ignore', '--stdin', '-z', '-n', '-v'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const checker: Checker = { git, waiting: [], fields: [], partial: '' }
    this.checker = checker
    git.stdin.on('error', () => undefined)
    git.stderr.resume()
    git.stdout.on('data', (data: Buffer) => {
      const parts = (checker.partial + data.toString('utf8')).split('\0')
      checker.partial = parts.pop() ?? ''
      for (const part of parts) {
        checker.fields.push(part)
        // source, line, pattern, path: ignored when a pattern matched and does not negate.
        if (checker.fields.length === 4) {
          const pattern = checker.fields[2]!
          checker.fields = []
          checker.waiting.shift()?.(pattern !== '' && !pattern.startsWith('!'))
        }
      }
    })
    git.on('error', () => undefined)
    git.on('close', () => {
      // Its answers owed are given as ignored: nothing is sent on a guess. Gone on its own (git
      // failed): another one starts, so what git ignores stays left out.
      for (const done of checker.waiting.splice(0)) done(true)
      if (this.checker !== checker) return
      this.checker = undefined
      if (this.inside && Date.now() - this.restarted > 1000) {
        this.restarted = Date.now()
        this.open()
      }
    })
  }

  /** When a checker last started again on its own: not more than once a second. */
  private restarted = 0

  /** A .gitignore changed: git reads them once, so a new one starts; the old answers what it owes. */
  restart() {
    if (!this.inside) return
    const old = this.checker
    this.open()
    old?.git.stdin.end()
  }

  ignored(path: string) {
    // Only paths in the root are asked about (git stops at one outside it); any other is left out.
    if (!path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'))
      return Promise.resolve(true)
    if (ENV_FILE.test(baseName(path)) || this.included.has(path)) return Promise.resolve(false)
    // A folder on the way to an included path is walked.
    for (const included of this.included)
      if (included.startsWith(`${path}/`)) return Promise.resolve(false)
    const checker = this.checker
    // Outside a git work tree nothing is ignored; inside one, a checker restarting answers none.
    if (!checker) return Promise.resolve(this.inside)
    return new Promise<boolean>((done) => {
      checker.waiting.push(done)
      checker.git.stdin.write(`${path}\0`)
    })
  }

  close() {
    this.inside = false
    this.checker?.git.stdin.end()
  }
}

export class Reader {
  /** What the receiver was told the root holds, by path. */
  private readonly index = new Map<string, Entry>()
  private readonly watchers = new Map<string, FSWatcher>()
  private readonly pending = new Set<string>()
  private timer?: NodeJS.Timeout
  /** Writes in order: a frame is whole before the next starts. */
  private writing: Promise<void> = Promise.resolve()
  /** Batches in order: one at a time. */
  private working: Promise<void> = Promise.resolve()
  private readonly ignores: Ignores
  private readonly warned = new Set<string>()

  constructor(
    private readonly root: string,
    private readonly out: NodeJS.WritableStream,
    options: { include?: string[]; warn?: (text: string) => void } = {},
  ) {
    this.ignores = new Ignores(root, new Set(options.include ?? []))
    this.warn = options.warn ?? ((text) => process.stderr.write(`${text}\n`))
  }

  private readonly warn: (text: string) => void

  /** The root, links resolved: nothing read lies outside it. */
  private rootReal = ''

  /** Walk the root, watching its folders, then send the manifest: the receiver answers with what it lacks. */
  start() {
    return this.then(async () => {
      this.rootReal = await realpath(this.root)
      await this.ignores.start()
      await this.walk('')
      await this.manifest()
    })
  }

  /** The manifest again, after what is under way: the receiver asks for what it lacks. */
  sendManifest() {
    return this.then(() => this.manifest())
  }

  private manifest() {
    const files: [string, number, number, number][] = []
    const links: [string, string][] = []
    for (const [path, entry] of this.index)
      if ('link' in entry) links.push([path, entry.link])
      else files.push([path, entry.size, entry.mtimeMs, entry.mode])
    return this.frame({ t: 'manifest', files, links })
  }

  /** Whatever changed is sent now, then a mark the receiver acknowledges once all is written. */
  flush(id: number) {
    clearTimeout(this.timer)
    this.timer = undefined
    this.batch()
    return this.then(() => this.frame({ t: 'mark', id }))
  }

  /** After what is under way: one thing at a time, and a failure does not stop what comes next. */
  private then(work: () => Promise<unknown>) {
    this.working = this.working.then(work).then(
      () => undefined,
      (error: unknown) => this.warn(`[preview] The sync skipped a change: ${String(error)}`),
    )
    return this.working
  }

  close() {
    clearTimeout(this.timer)
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
    this.ignores.close()
  }

  /**
   * A frame, whole before the next starts: its header line, then its body, given whole or written
   * by `body` a chunk at a time (a large file's, read as it goes).
   */
  private frame(header: object, body?: Buffer | ((write: Write) => Promise<void>)) {
    this.writing = this.writing.then(async () => {
      await this.write(`${JSON.stringify(header)}\n`)
      if (typeof body === 'function') await body((chunk) => this.write(chunk))
      else if (body) await this.write(body)
    })
    return this.writing
  }

  /** Once the stream took it: while it holds more than it wants, until it drained. */
  private write(chunk: Buffer | string) {
    return new Promise<void>((done) => {
      if (this.out.write(chunk)) done()
      else this.out.once('drain', () => done())
    })
  }

  private async walk(dir: string) {
    if (dir) {
      if (await this.ignores.ignored(dir)) return
      this.watchDir(dir)
    } else this.watchDir('')
    let entries
    try {
      entries = await readdir(join(this.root, dir), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (SKIPPED.has(entry.name)) continue
      const path = rel(dir, entry.name)
      if (entry.isDirectory()) await this.walk(path)
      else await this.check(path, false)
    }
  }

  private watchDir(dir: string) {
    if (this.watchers.has(dir)) return
    try {
      const watcher = watch(join(this.root, dir), { persistent: true }, (_event, name) => {
        if (name) this.schedule(rel(dir, name.toString().split(sep).join('/')))
        // No name: something changed in it, unsaid what; it is looked at again.
        else this.schedule(dir)
      })
      watcher.on('error', () => {
        watcher.close()
        this.watchers.delete(dir)
        if (dir) this.schedule(dir)
      })
      this.watchers.set(dir, watcher)
    } catch {
      // Gone already, or not readable: nothing to watch.
    }
  }

  private schedule(path: string) {
    this.pending.add(path)
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.batch()
    }, BATCH_MS)
  }

  private batch() {
    if (this.pending.size === 0) return
    const paths = [...this.pending].sort()
    this.pending.clear()
    void this.then(async () => {
      for (const path of paths) await this.check(path, true)
    })
  }

  /**
   * Look at a path now: send it when it changed (with `send`; else only note it for the
   * manifest), say it is gone, or walk a new folder. `again`: it changed while it went just now.
   */
  private async check(path: string, send: boolean, again = false) {
    if (!path || skipped(path)) {
      if (!path) await this.rescan('')
      return
    }
    let stat
    try {
      stat = await lstat(join(this.root, path))
    } catch {
      return this.gone(path)
    }
    if (stat.isDirectory()) {
      if (!this.watchers.has(path)) {
        if (await this.ignores.ignored(path)) return
        // A new folder (or one moved here): all it holds is new too.
        await this.walkSending(path)
      } else await this.rescan(path)
      return
    }
    if (baseName(path) === '.gitignore') this.ignores.restart()
    if (await this.ignores.ignored(path)) return
    const before = this.index.get(path)
    if (stat.isSymbolicLink()) {
      const target = await readlink(join(this.root, path)).catch(() => null)
      if (target === null) return this.gone(path)
      // Unchanged since sent, unless the receiver asked for it: it lacks it.
      if (before && 'link' in before && before.link === target && !this.needed) return
      this.index.set(path, { link: target })
      if (send) await this.frame({ t: 'link', p: path, to: target })
      return
    }
    if (!stat.isFile()) return
    if (stat.size > FILE_MAX) {
      if (!this.warned.has(path)) {
        this.warned.add(path)
        this.warn(`[preview] ${path} is not sent to the thread's machine: over 2 GB`)
      }
      // Nor kept there as it was before: nothing on the machine runs on an older copy of it.
      return this.gone(path)
    }
    const entry = { size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs), mode: stat.mode & 0o777 }
    const same =
      before !== undefined &&
      !('link' in before) &&
      before.size === entry.size &&
      before.mtimeMs === entry.mtimeMs &&
      before.mode === entry.mode
    // Unchanged since sent, unless the receiver asked for it: it lacks it.
    if (same && !this.needed) return
    this.index.set(path, entry)
    if (!send) return
    // A folder on its way that became a link to elsewhere: nothing there is read.
    if (!(await this.inside(path))) return
    const sent = await this.send(path, stat)
    if (sent === 'gone') return this.gone(path)
    if (sent === 'changed') {
      // What the machine has is not this file: noted as no file can be, so that it goes again,
      // now once, then with a later batch (a file rewritten over and over holds nothing up).
      const told = this.index.get(path)
      if (told && !('link' in told)) this.index.set(path, { ...told, size: -1 })
      if (again) this.schedule(path)
      else await this.check(path, true, true)
    }
  }

  /**
   * The file at `path` as it is now, from one open file: read whole when small, else a chunk at
   * a time as the stream takes them, and always the size its header says. 'changed': it is no
   * longer the file `seen` (replaced, or grown past the limit), or it was cut short on the way,
   * the rest sent as zeros. 'gone': it could not be read (on the way too: then as zeros).
   */
  private async send(path: string, seen: Stats): Promise<'sent' | 'changed' | 'gone'> {
    let file: FileHandle
    try {
      // Not held up by what is no file (a pipe put in its place): let go below.
      file = await open(join(this.root, path), constants.O_RDONLY | constants.O_NONBLOCK)
    } catch {
      return 'gone'
    }
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.ino !== seen.ino || stat.dev !== seen.dev || stat.size > FILE_MAX)
        return 'changed'
      const mode = stat.mode & 0o777
      const mtimeMs = Math.trunc(stat.mtimeMs)
      if (stat.size <= STREAM_MIN) {
        const body = Buffer.allocUnsafe(stat.size)
        const read = await readInto(file, body, 0)
        this.index.set(path, { size: read, mtimeMs, mode })
        await this.frame(
          { t: 'file', p: path, s: read, m: mode, mt: mtimeMs },
          body.subarray(0, read),
        )
        return 'sent'
      }
      this.index.set(path, { size: stat.size, mtimeMs, mode })
      let went: Awaited<ReturnType<typeof chunks>> = 'whole'
      await this.frame(
        { t: 'file', p: path, s: stat.size, m: mode, mt: mtimeMs },
        async (write) => {
          went = await chunks(file, stat.size, write)
        },
      )
      return went === 'whole' ? 'sent' : went === 'short' ? 'changed' : 'gone'
    } catch {
      return 'gone'
    } finally {
      await file.close().catch(() => undefined)
    }
  }

  /** Set while sending what the receiver asked for: sent even when unchanged here. */
  private needed = false

  private async walkSending(dir: string) {
    if (!(await this.inside(dir))) return
    this.watchDir(dir)
    let entries
    try {
      entries = await readdir(join(this.root, dir), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (SKIPPED.has(entry.name)) continue
      const path = rel(dir, entry.name)
      if (entry.isDirectory()) {
        if (!(await this.ignores.ignored(path))) await this.walkSending(path)
      } else await this.check(path, true)
    }
  }

  /** A folder said something changed in it without a name: what it holds is looked at again. */
  private async rescan(dir: string) {
    let entries
    try {
      entries = await readdir(join(this.root, dir), { withFileTypes: true })
    } catch {
      return this.gone(dir)
    }
    // What was sent from it and is no longer there: a file, or a folder with all it held.
    const here = new Set(entries.map((e) => rel(dir, e.name)))
    const prefix = dir ? `${dir}/` : ''
    const children = new Set<string>()
    for (const path of this.index.keys())
      if (path.startsWith(prefix)) children.add(prefix + path.slice(prefix.length).split('/')[0]!)
    for (const child of children) if (!here.has(child)) await this.gone(child)
    for (const entry of entries) {
      if (SKIPPED.has(entry.name)) continue
      const path = rel(dir, entry.name)
      if (entry.isDirectory()) {
        if (!this.watchers.has(path) && !(await this.ignores.ignored(path)))
          await this.walkSending(path)
      } else await this.check(path, true)
    }
  }

  /** Gone from the root: so it goes from the machine, with all under it when it was a folder. */
  private async gone(path: string) {
    const under = `${path}/`
    let known = this.index.delete(path)
    for (const key of [...this.index.keys()])
      if (key.startsWith(under)) {
        this.index.delete(key)
        known = true
      }
    for (const [dir, watcher] of [...this.watchers])
      if (dir === path || dir.startsWith(under)) {
        watcher.close()
        this.watchers.delete(dir)
      }
    if (known) await this.frame({ t: 'del', p: path })
  }

  /** Send these as they are now, changed or not: the receiver lacks them. */
  private async sendAll(paths: string[]) {
    this.needed = true
    try {
      for (const path of paths) await this.check(path, true)
    } finally {
      this.needed = false
    }
  }

  /**
   * What the receiver lacks, sent after what is under way: only paths of the manifest, the
   * reader's own. The receiver's machine runs code nobody here vetted, so what it asks for is
   * never a path to read as is (`../`, a home's logins).
   */
  answerNeed(paths: unknown[]) {
    const known = paths.filter((p): p is string => typeof p === 'string' && this.index.has(p))
    return this.then(() => this.sendAll(known))
  }

  /** Whether a path, links resolved, is in the root: what is read never lies outside it. */
  private async inside(path: string) {
    const real = await realpath(join(this.root, path)).catch(() => null)
    return real !== null && (real === this.rootReal || real.startsWith(`${this.rootReal}${sep}`))
  }
}

/** Read into `buffer` from `position` until it is full or the file ends: how many bytes came. */
async function readInto(file: FileHandle, buffer: Buffer, position: number) {
  let read = 0
  while (read < buffer.length) {
    const { bytesRead } = await file.read(buffer, read, buffer.length - read, position + read)
    if (bytesRead === 0) break
    read += bytesRead
  }
  return read
}

/**
 * `size` bytes of an open file from its start, a chunk at a time, each read once the stream took
 * the one before. 'short': the file ended sooner (cut short on the way), 'failed': it could not
 * be read; either way what it lacked went as zeros, so the receiver still gets the size the
 * header said.
 */
async function chunks(file: FileHandle, size: number, write: Write) {
  let went: 'whole' | 'short' | 'failed' = 'whole'
  for (let at = 0; at < size;) {
    // A buffer of its own each time: the stream may still hold the one before.
    const chunk = Buffer.allocUnsafe(Math.min(CHUNK, size - at))
    let read = 0
    if (went === 'whole')
      try {
        read = await readInto(file, chunk, at)
        if (read < chunk.length) went = 'short'
      } catch {
        went = 'failed'
      }
    chunk.fill(0, read)
    await write(chunk)
    at += chunk.length
  }
  return went
}

/** As a program: the root from argv, frames to stdout, the runner's lines from stdin. */
async function main() {
  const [root, ...rest] = process.argv.slice(2)
  if (!root) {
    process.stderr.write('usage: preview-sync-reader <root> [--include <path>]...\n')
    process.exit(2)
  }
  const include: string[] = []
  for (let i = 0; i < rest.length; i++)
    if (rest[i] === '--include' && rest[i + 1]) include.push(rest[++i]!)
  const reader = new Reader(root, process.stdout, { include })
  process.stdout.on('error', () => process.exit(0))
  const lines = createInterface({ input: process.stdin })
  lines.on('line', (line) => {
    let message: { t?: string; paths?: string[]; id?: number }
    try {
      message = JSON.parse(line) as typeof message
    } catch {
      return
    }
    if (message.t === 'need' && Array.isArray(message.paths)) void reader.answerNeed(message.paths)
    else if (message.t === 'flush' && typeof message.id === 'number') void reader.flush(message.id)
    else if (message.t === 'resync') void reader.sendManifest()
  })
  // The runner went away: so does this.
  lines.on('close', () => {
    reader.close()
    process.exit(0)
  })
  await reader.start()
}

if (process.argv[1] && /preview-sync-reader\.[cm]?[jt]s$/.test(process.argv[1])) void main()
