// The receiving half of a preview machine's sync (docs/previews.md, preview-machine.ts): run on
// the machine, over SSH, it writes what the reader (preview-sync-reader.ts) sends into the
// machine's copy of the checkout. Each file's bytes go, as they come, into a staging folder
// beside its state file, outside the copy (a body is never whole in memory: footage goes up to
// 2 GB); once all came, the file is moved in place whole, so a dev server's watcher sees one
// change, as it would from an editor. It deletes only what it wrote itself (kept in its state
// file): what the machine made (dependencies, builds, the preview's database) is never touched.
// Only node: modules: it is copied to the machine as one file.
//
//   node preview-sync-receiver.mjs <root> <state file>
//
// stdin: the reader's frames. stdout: JSON lines for the runner: the paths it needs after a
// manifest, an acknowledgement of each mark once all before it is written, errors.
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readlink,
  rename,
  rm,
  rmdir,
  symlink,
  unlink,
  utimes,
  writeFile,
  type FileHandle,
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

type Header =
  | { t: 'manifest'; files: [string, number, number, number][]; links: [string, string][] }
  | { t: 'file'; p: string; s: number; m: number; mt: number }
  | { t: 'link'; p: string; to: string }
  | { t: 'del'; p: string }
  | { t: 'mark'; id: number }
type FileHeader = Extract<Header, { t: 'file' }>

/**
 * The file whose bytes are coming, and how many are still to come: written to its staged file,
 * or dropped when it has none (a path refused, a write that failed, said once all came).
 */
type Body = {
  header: FileHeader
  left: number
  staged?: { path: string; file: FileHandle }
  failed?: string
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** A path the reader may name: relative, inside the root, never through `..`. */
export function safePath(path: unknown): path is string {
  if (typeof path !== 'string' || !path || path.length > 4096) return false
  if (path.startsWith('/') || path.includes('\0') || path.includes('\\')) return false
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

export class Receiver {
  /** The paths it wrote, so it deletes nothing else. */
  private synced: Set<string>
  /** The start of a header line whose end is still to come. */
  private line: Buffer[] = []
  private body?: Body
  /** Bytes in order: each push taken whole before the next. */
  private taking: Promise<void> = Promise.resolve()
  private applying: Promise<void> = Promise.resolve()
  private saveTimer?: NodeJS.Timeout

  constructor(
    private readonly root: string,
    private readonly stateFile: string,
    private readonly say: (message: object) => void,
    /** Where bodies are written as they come, outside the copy: beside the state file. */
    readonly staging = join(dirname(stateFile), `${basename(stateFile, '.json')}.staging`),
  ) {
    let saved: unknown = []
    try {
      saved = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : []
    } catch {
      saved = []
    }
    this.synced = new Set(Array.isArray(saved) ? saved.filter(safePath) : [])
    // What a receiver that stopped short left there: nothing in it is ever placed.
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
  }

  /**
   * Bytes from the reader: frames applied in order. Resolves once they are taken, a body's
   * written to its staged file: whoever feeds it waits for that before the next (backpressure).
   */
  push(data: Buffer) {
    this.taking = this.taking.then(() => this.take(data))
    return this.taking
  }

  /** The reader is gone: what came is applied, a body it did not finish dropped (never placed). */
  async end() {
    await this.taking
    const body = this.body
    this.body = undefined
    this.line = []
    if (body) await this.discard(body)
    await this.idle()
  }

  private async take(data: Buffer) {
    let at = 0
    while (at < data.length) {
      if (this.body) {
        const take = Math.min(this.body.left, data.length - at)
        await this.bodyBytes(this.body, data.subarray(at, at + take))
        at += take
        if (this.body.left === 0) await this.bodyDone()
        continue
      }
      const end = data.indexOf(10, at)
      if (end < 0) {
        this.line.push(data.subarray(at))
        return
      }
      const line = Buffer.concat([...this.line, data.subarray(at, end)]).toString('utf8')
      this.line = []
      at = end + 1
      let header: Header
      try {
        header = JSON.parse(line) as Header
      } catch {
        this.say({ t: 'error', message: 'unreadable frame' })
        continue
      }
      if (header.t === 'file') {
        if (!Number.isSafeInteger(header.s) || header.s < 0) {
          this.say({ t: 'error', message: 'bad file size' })
          continue
        }
        this.body = await this.bodyFor(header)
        if (this.body.left === 0) await this.bodyDone()
        continue
      }
      this.queue(() => this.apply(header))
    }
  }

  /**
   * Where a file's bytes go as they come: decided on its header, so a path refused is never
   * written, even staged: its bytes are read and dropped, and the frame after it applies.
   */
  private async bodyFor(header: FileHeader): Promise<Body> {
    if (!safePath(header.p)) {
      this.say({ t: 'error', message: 'A path outside the copy' })
      return { header, left: header.s }
    }
    const path = join(this.staging, `${randomBytes(6).toString('hex')}.part`)
    try {
      return { header, left: header.s, staged: { path, file: await open(path, 'wx', 0o600) } }
    } catch (error) {
      return { header, left: header.s, failed: message(error) }
    }
  }

  private async bodyBytes(body: Body, chunk: Buffer) {
    body.left -= chunk.length
    if (!body.staged) return
    try {
      for (let at = 0; at < chunk.length;) {
        const { bytesWritten } = await body.staged.file.write(chunk, at, chunk.length - at)
        at += bytesWritten
      }
    } catch (error) {
      // The disk is full, say: the rest is dropped as it comes, and the file stays as it was.
      body.failed = message(error)
      await this.discard(body)
    }
  }

  /** All its bytes came: placed in its turn, after the frames before it. */
  private async bodyDone() {
    const body = this.body!
    this.body = undefined
    if (body.staged) {
      const { path, file } = body.staged
      try {
        await file.close()
        this.queue(() => this.place(body.header, path))
        return
      } catch (error) {
        body.failed = message(error)
        await this.discard(body)
      }
    }
    if (body.failed) this.say({ t: 'error', message: body.failed })
  }

  /** Its staged file goes, as far as it can. */
  private async discard(body: Body) {
    const staged = body.staged
    body.staged = undefined
    if (!staged) return
    await staged.file.close().catch(() => undefined)
    await rm(staged.path, { force: true }).catch(() => undefined)
  }

  /** Once all frames so far are applied. */
  idle() {
    return this.applying
  }

  private queue(work: () => Promise<void>) {
    this.applying = this.applying.then(work).catch((error: unknown) => {
      this.say({ t: 'error', message: message(error) })
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
        Math.trunc(stat.mtimeMs) !== mtimeMs ||
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

  /**
   * A staged file, all its bytes there, moved in place with its mode and time, so it appears
   * whole. Whatever happens, it leaves the staging folder.
   */
  private async place(header: FileHeader, staged: string) {
    const target = join(this.root, header.p)
    const mode = header.m & 0o777
    const mtime = new Date(header.mt)
    try {
      await this.makeRoom(target)
      await chmod(staged, mode)
      await utimes(staged, mtime, mtime)
      try {
        await rename(staged, target)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
        await this.copyInPlace(staged, target, mode, mtime)
        await rm(staged, { force: true }).catch(() => undefined)
      }
    } catch (error) {
      await rm(staged, { force: true }).catch(() => undefined)
      throw error
    }
    this.synced.add(header.p)
    this.scheduleSave()
  }

  /**
   * The staging folder is on another filesystem than the copy: the file is copied beside its
   * place first, then moved there, so that it still appears whole.
   */
  private async copyInPlace(staged: string, target: string, mode: number, mtime: Date) {
    const beside = join(dirname(target), `.${randomBytes(6).toString('hex')}.brigade-sync`)
    try {
      await copyFile(staged, beside)
      await chmod(beside, mode)
      await utimes(beside, mtime, mtime)
      await rename(beside, target)
    } catch (error) {
      await rm(beside, { force: true }).catch(() => undefined)
      throw error
    }
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
  try {
    // A chunk at a time, each taken before the next is read: a disk slower than the link holds
    // the reader back, through SSH, rather than filling this one's memory.
    for await (const data of process.stdin) await receiver.push(data as Buffer)
  } catch {
    // The link was cut: as at its end.
  }
  // Then it ends by itself once nothing is left to do, its last save included. Not with
  // process.exit(), which hung there now and then (about one end in ten after a large file).
  await receiver.end()
}

if (process.argv[1] && /preview-sync-receiver\.[cm]?[jt]s$/.test(process.argv[1])) void main()
