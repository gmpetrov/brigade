// The sending half of a preview machine's sync (docs/previews.md, preview-machine.ts): run as the
// teammate, in its thread's namespaces, so it reads the checkout as the app would. It says what
// the checkout holds (a manifest), sends the files the machine asks for, then watches the
// checkout and sends each change as it happens. One way only: nothing comes back into the
// checkout. Only node: modules, so it runs as a file of its own.
//
//   node preview-sync-reader.js <root> [--include <path>]...
//
// stdout: frames for the receiver (preview-sync-receiver.ts), each a JSON line, then for a file
// its bytes. stdin: JSON lines from the runner: the paths the receiver needs, a flush (send what
// changed now, then a mark the receiver acknowledges) or a resync (the manifest again, after the
// link to the machine was cut). Left out: .git and node_modules anywhere, and whatever git
// ignores (builds, caches, the preview's own database), except .env files, which the app reads.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { watch, type FSWatcher } from 'node:fs'
import { lstat, readFile, readdir, readlink } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { createInterface } from 'node:readline'

/** Never sent, wherever they are: git's own files, and dependencies the machine installs. */
const SKIPPED = new Set(['.git', 'node_modules'])
/** Sent even when git ignores them: the app's own settings (.env, .env.local…). */
const ENV_FILE = /^\.env(\..+)?$/
/** A file larger than this is not sent (a video in the repository): said once on stderr. */
const FILE_MAX = 100 * 1024 ** 2
/** Changes this close together go as one batch. */
const BATCH_MS = 15

type Entry = { size: number; mtimeMs: number; mode: number } | { link: string }

/** A path relative to the root, with / between its parts whatever the system's separator. */
const rel = (...parts: string[]) => parts.filter(Boolean).join('/')
const skipped = (path: string) => path.split('/').some((part) => SKIPPED.has(part))
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/**
 * Whether git ignores paths, asked of one `git check-ignore --stdin` that answers each path as
 * it comes. Tracked files are never ignored. Outside a git work tree, nothing is.
 */
class Ignores {
  private git?: ChildProcessWithoutNullStreams
  private waiting: ((ignored: boolean) => void)[] = []
  private fields: string[] = []
  private partial = ''

  /** `included`: paths sent even when git ignores them (the app's env file). */
  constructor(
    private readonly root: string,
    private readonly included: Set<string> = new Set(),
  ) {}

  async start() {
    const inside = await new Promise<boolean>((done) => {
      const probe = spawn('git', ['-C', this.root, 'rev-parse', '--is-inside-work-tree'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      let out = ''
      probe.stdout.on('data', (d: Buffer) => (out += d.toString()))
      probe.on('error', () => done(false))
      probe.on('close', (code) => done(code === 0 && out.trim() === 'true'))
    })
    if (inside) this.open()
  }

  private open() {
    const git = spawn('git', ['-C', this.root, 'check-ignore', '--stdin', '-z', '-n', '-v'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.git = git
    git.stdin.on('error', () => undefined)
    git.stderr.resume()
    git.stdout.on('data', (data: Buffer) => {
      const parts = (this.partial + data.toString('utf8')).split('\0')
      this.partial = parts.pop() ?? ''
      for (const part of parts) {
        this.fields.push(part)
        // source, line, pattern, path: ignored when a pattern matched and does not negate.
        if (this.fields.length === 4) {
          const pattern = this.fields[2]!
          this.fields = []
          this.waiting.shift()?.(pattern !== '' && !pattern.startsWith('!'))
        }
      }
    })
    git.on('close', () => {
      // Gone (git failed, or restarted below): what it did not answer is not ignored.
      if (this.git === git) this.git = undefined
      for (const done of this.waiting.splice(0)) done(false)
    })
  }

  /** A .gitignore changed: git reads them once, so it starts again. */
  restart() {
    const old = this.git
    if (!old) return
    this.git = undefined
    this.fields = []
    this.partial = ''
    old.stdin.end()
    this.open()
  }

  ignored(path: string) {
    if (ENV_FILE.test(baseName(path)) || this.included.has(path)) return Promise.resolve(false)
    // A folder on the way to an included path is walked.
    for (const included of this.included)
      if (included.startsWith(`${path}/`)) return Promise.resolve(false)
    const git = this.git
    if (!git) return Promise.resolve(false)
    return new Promise<boolean>((done) => {
      this.waiting.push(done)
      git.stdin.write(`${path}\0`)
    })
  }

  close() {
    this.git?.stdin.end()
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

  /** Walk the root, watching its folders, and send the manifest (mark `id` once the files are sent). */
  async start() {
    await this.ignores.start()
    await this.walk('')
    await this.sendManifest()
  }

  /** The manifest again, from what was sent: the receiver asks for what it lacks. */
  sendManifest() {
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
    this.working = this.working.then(() => this.frame({ t: 'mark', id }))
    return this.working
  }

  close() {
    clearTimeout(this.timer)
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
    this.ignores.close()
  }

  private frame(header: object, body?: Buffer) {
    this.writing = this.writing.then(
      () =>
        new Promise<void>((done) => {
          const ok = this.out.write(`${JSON.stringify(header)}\n`)
          const more = body ? this.out.write(body) : true
          if (ok && more) done()
          else this.out.once('drain', () => done())
        }),
    )
    return this.writing
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
    this.working = this.working.then(async () => {
      for (const path of paths) await this.check(path, true)
    })
  }

  /**
   * Look at a path now: send it when it changed (with `send`; else only note it for the
   * manifest), say it is gone, or walk a new folder.
   */
  private async check(path: string, send: boolean) {
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
      if (before && 'link' in before && before.link === target) return
      this.index.set(path, { link: target })
      if (send) await this.frame({ t: 'link', p: path, to: target })
      return
    }
    if (!stat.isFile()) return
    if (stat.size > FILE_MAX) {
      if (!this.warned.has(path)) {
        this.warned.add(path)
        this.warn(`[preview] ${path} is not sent to the preview's machine: over 100 MB`)
      }
      return
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
    let body: Buffer
    try {
      body = await readFile(join(this.root, path))
    } catch {
      return this.gone(path)
    }
    await this.frame({ t: 'file', p: path, s: body.length, m: entry.mode, mt: entry.mtimeMs }, body)
  }

  /** Set while sending what the receiver asked for: sent even when unchanged here. */
  private needed = false

  private async walkSending(dir: string) {
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
  async sendAll(paths: string[]) {
    this.needed = true
    try {
      for (const path of paths) await this.check(path, true)
    } finally {
      this.needed = false
    }
  }

  /** Queue sendAll after what is under way. */
  answerNeed(paths: string[]) {
    this.working = this.working.then(() => this.sendAll(paths))
    return this.working
  }
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
