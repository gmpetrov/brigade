// The receiving half of a preview machine's sync (docs/previews.md, preview-machine.ts): run on
// the machine, over SSH, it writes what the reader (preview-sync-reader.ts) sends into the
// machine's copy of the checkout. Each file is written whole and then moved in place, so a dev
// server's watcher sees one change, as it would from an editor. It deletes only what it wrote
// itself (kept in its state file): what the machine made (dependencies, builds, the preview's
// database) is never touched. Only node: modules: it is copied to the machine as one file.
//
//   node preview-sync-receiver.mjs <root> <state file>
//
// stdin: the reader's frames. stdout: JSON lines for the runner: the paths it needs after a
// manifest, an acknowledgement of each mark once all before it is written, errors.
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  readlink,
  rename,
  rm,
  rmdir,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'

type Header =
  | { t: 'manifest'; files: [string, number, number, number][]; links: [string, string][] }
  | { t: 'file'; p: string; s: number; m: number; mt: number }
  | { t: 'link'; p: string; to: string }
  | { t: 'del'; p: string }
  | { t: 'mark'; id: number }

/**
 * Two times of a file, in whole milliseconds, the same: equal, or in the same second when one has
 * nothing under it, as a filesystem that keeps whole seconds leaves it. Boat serves a woken
 * machine's home through ascii-lazyfs for a few minutes, which does: compared to the millisecond,
 * every file would go again after each wake.
 */
function sameTime(a: number, b: number) {
  return (
    a === b || (Math.floor(a / 1000) === Math.floor(b / 1000) && (a % 1000 === 0 || b % 1000 === 0))
  )
}

/** A path the reader may name: relative, inside the root, never through `..`. */
export function safePath(path: unknown): path is string {
  if (typeof path !== 'string' || !path || path.length > 4096) return false
  if (path.startsWith('/') || path.includes('\0') || path.includes('\\')) return false
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

export class Receiver {
  /** The paths it wrote, so it deletes nothing else. */
  private synced: Set<string>
  private buffer: Buffer = Buffer.alloc(0)
  /** The file whose bytes are coming, and how many are still to come. */
  private body?: { header: Extract<Header, { t: 'file' }>; chunks: Buffer[]; left: number }
  private applying: Promise<void> = Promise.resolve()
  private saveTimer?: NodeJS.Timeout

  constructor(
    private readonly root: string,
    private readonly stateFile: string,
    private readonly say: (message: object) => void,
  ) {
    let saved: unknown = []
    try {
      saved = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : []
    } catch {
      saved = []
    }
    this.synced = new Set(Array.isArray(saved) ? saved.filter(safePath) : [])
  }

  /** Bytes from the reader: frames applied in order. */
  push(data: Buffer) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, data]) : data
    for (;;) {
      if (this.body) {
        const take = Math.min(this.body.left, this.buffer.length)
        if (take > 0) {
          this.body.chunks.push(this.buffer.subarray(0, take))
          this.body.left -= take
          this.buffer = this.buffer.subarray(take)
        }
        if (this.body.left > 0) return
        const { header, chunks } = this.body
        this.body = undefined
        const content = Buffer.concat(chunks)
        this.queue(() => this.writeFile(header, content))
        continue
      }
      const end = this.buffer.indexOf(10)
      if (end < 0) return
      const line = this.buffer.subarray(0, end).toString('utf8')
      this.buffer = this.buffer.subarray(end + 1)
      let header: Header
      try {
        header = JSON.parse(line) as Header
      } catch {
        this.say({ t: 'error', message: 'unreadable frame' })
        continue
      }
      if (header.t === 'file') {
        if (!Number.isInteger(header.s) || header.s < 0) {
          this.say({ t: 'error', message: 'bad file size' })
          continue
        }
        this.body = { header, chunks: [], left: header.s }
        continue
      }
      this.queue(() => this.apply(header))
    }
  }

  /** Once all frames so far are applied. */
  idle() {
    return this.applying
  }

  private queue(work: () => Promise<void>) {
    this.applying = this.applying.then(work).catch((error: unknown) => {
      this.say({ t: 'error', message: error instanceof Error ? error.message : String(error) })
    })
  }

  private async apply(header: Header) {
    if (header.t === 'manifest') return this.manifest(header)
    if (header.t === 'mark') {
      await this.save()
      return this.say({ t: 'ack', id: header.id })
    }
    if (!('p' in header) || !safePath(header.p)) throw new Error('A path outside the copy')
    if (header.t === 'link') return this.writeLink(header.p, header.to)
    if (header.t === 'del') return this.delete(header.p)
  }

  /** Compare with what is here: ask for what differs, delete what was sent before and is gone. */
  private async manifest(header: Extract<Header, { t: 'manifest' }>) {
    const named = new Set<string>()
    const need: string[] = []
    for (const [path, size, mtimeMs, mode] of header.files) {
      if (!safePath(path)) continue
      named.add(path)
      const stat = await lstat(join(this.root, path)).catch(() => null)
      if (
        !stat?.isFile() ||
        stat.size !== size ||
        !sameTime(Math.trunc(stat.mtimeMs), mtimeMs) ||
        (stat.mode & 0o777) !== mode
      )
        need.push(path)
    }
    for (const [path, target] of header.links) {
      if (!safePath(path)) continue
      named.add(path)
      const here = await readlink(join(this.root, path)).catch(() => null)
      if (here !== target) need.push(path)
    }
    for (const path of [...this.synced]) if (!named.has(path)) await this.delete(path)
    this.scheduleSave()
    this.say({ t: 'need', paths: need })
  }

  private async writeFile(header: Extract<Header, { t: 'file' }>, content: Buffer) {
    if (!safePath(header.p)) throw new Error('A path outside the copy')
    const target = join(this.root, header.p)
    await this.makeRoom(target)
    const temporary = join(dirname(target), `.${randomBytes(6).toString('hex')}.brigade-sync`)
    await writeFile(temporary, content, { mode: header.m & 0o777 })
    await chmod(temporary, header.m & 0o777)
    const mtime = new Date(header.mt)
    await utimes(temporary, mtime, mtime)
    await rename(temporary, target)
    this.synced.add(header.p)
    this.scheduleSave()
  }

  private async writeLink(path: string, to: string) {
    const target = join(this.root, path)
    await this.makeRoom(target)
    await rm(target, { force: true, recursive: true })
    await symlink(to, target)
    this.synced.add(path)
    this.scheduleSave()
  }

  /**
   * Its folder exists, and nothing is in the way: no folder where the file goes (a folder became
   * a file), no file where one of its folders goes (a file became a folder).
   */
  private async makeRoom(target: string) {
    const folder = dirname(target)
    try {
      await mkdir(folder, { recursive: true })
    } catch {
      const parts = folder.slice(this.root.length + 1).split('/')
      for (let i = 1; i <= parts.length; i++) {
        const path = join(this.root, ...parts.slice(0, i))
        const stat = await lstat(path).catch(() => null)
        if (stat && !stat.isDirectory()) {
          await unlink(path)
          this.synced.delete(parts.slice(0, i).join('/'))
        }
      }
      await mkdir(folder, { recursive: true })
    }
    const stat = await lstat(target).catch(() => null)
    if (stat?.isDirectory()) await rm(target, { recursive: true, force: true })
  }

  /** Deleted, with what it wrote under it when it was a folder; folders it emptied go too. */
  private async delete(path: string) {
    const under = `${path}/`
    const gone = [...this.synced].filter((p) => p === path || p.startsWith(under))
    for (const p of gone) {
      await unlink(join(this.root, p)).catch(() => undefined)
      this.synced.delete(p)
      await this.dropEmpty(dirname(join(this.root, p)))
    }
    this.scheduleSave()
  }

  private async dropEmpty(dir: string) {
    while (dir.startsWith(`${this.root}/`)) {
      try {
        await rmdir(dir)
      } catch {
        return
      }
      dir = dirname(dir)
    }
  }

  private scheduleSave() {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => void this.save(), 1000)
  }

  private async save() {
    clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    await mkdir(dirname(this.stateFile), { recursive: true })
    const temporary = `${this.stateFile}.${randomBytes(4).toString('hex')}`
    await writeFile(temporary, JSON.stringify([...this.synced]))
    await rename(temporary, this.stateFile)
  }
}

/** As a program: the root and state file from argv, frames from stdin, lines to stdout. */
async function main() {
  const [root, stateFile] = process.argv.slice(2)
  if (!root || !stateFile) {
    process.stderr.write('usage: preview-sync-receiver <root> <state file>\n')
    process.exit(2)
  }
  await mkdir(root, { recursive: true })
  const receiver = new Receiver(root, stateFile, (message) =>
    process.stdout.write(`${JSON.stringify(message)}\n`),
  )
  process.stdin.on('data', (data: Buffer) => receiver.push(data))
  process.stdin.on('end', () => void receiver.idle().then(() => process.exit(0)))
}

if (process.argv[1] && /preview-sync-receiver\.[cm]?[jt]s$/.test(process.argv[1])) void main()
