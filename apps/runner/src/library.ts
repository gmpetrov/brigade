// The workspace library, mirrored on this computer, and the memory teammates
// load. The API is the source; this copy follows it. Each teammate that runs
// here gets its own mirror, of only the folders it may read: hard links into
// one private store of the files' bytes, so a file is kept once however many
// teammates see it. On a cloud computer a teammate's mirror belongs to its
// Linux user's group (the root helper makes it), so no other teammate can open
// it; the store is the runner's alone.
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import {
  copyFile,
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { promisify } from 'node:util'
import { libraryAccessFor, LibraryManifest } from '@brigade/contracts'
import { CLOUD, HOME, paths, type RunnerConfig } from './config.js'
import type { MemorySnapshot } from './memory-layers.js'
import { teammateUser } from './teammates.js'

/** Where the library is mirrored: a folder per teammate, and the store. */
export const LIBRARY_DIR = CLOUD ? '/var/lib/brigade/library' : join(HOME, 'library')
/** The files' bytes, by SHA-256. Never shown to a teammate except through its own mirror. */
const STORE = join(LIBRARY_DIR, '.files')
/** Fetch again now and then, in case a change notice was missed. */
const RESYNC_MS = 15 * 60_000

const run = promisify(execFile)

/** A teammate's own mirror of the library. */
export const libraryDirFor = (teammateId: string) => join(LIBRARY_DIR, teammateUser(teammateId))

type Index = Record<string, string> // path -> sha256 of the mirrored copy
type Views = Record<string, Index> // teammate id -> its mirror

export class Library {
  private memory: LibraryManifest['memory'] = { workspace: '', teammates: {} }
  private running: Promise<void> | undefined
  private again = false
  private readonly viewsFile = join(paths.state, 'library-views.json')
  private readonly memoryFile = join(paths.state, 'memory.json')
  /** The mirror before protocol 13: every file, readable by every teammate. */
  private readonly legacyIndexFile = join(paths.state, 'library.json')
  /** Teammates asked for since the last sync wrote the views file. */
  private readonly added = new Set<string>()

  constructor(private readonly config: RunnerConfig) {
    // Memory from the last sync, until the first one of this process.
    void readFile(this.memoryFile, 'utf8')
      .then((text) => (this.memory = LibraryManifest.shape.memory.parse(JSON.parse(text))))
      .catch(() => undefined)
    setInterval(() => void this.sync(), RESYNC_MS).unref()
  }

  /** The memory a teammate loads: the workspace's and its own, with projects' and every line's date. */
  memoryFor(teammateId: string): MemorySnapshot {
    return {
      workspace: this.memory.workspace,
      teammate: this.memory.teammates[teammateId] ?? '',
      ...(this.memory.projects ? { projects: this.memory.projects } : {}),
      ...(this.memory.lines ? { lines: this.memory.lines } : {}),
      ...(this.memory.tidied ? { tidied: this.memory.tidied } : {}),
    }
  }

  /**
   * A teammate's mirror, filled before the first thread it runs here. On a
   * cloud computer its Linux user must exist first.
   */
  async view(teammateId: string) {
    // A sync already running may have started before this teammate was asked for: then the next one.
    for (let tries = 0; tries < 3 && !(await this.readViews())[teammateId]; tries++) {
      this.added.add(teammateId)
      await this.sync()
    }
    return libraryDirFor(teammateId)
  }

  /** Bring the mirrors and memory up to date. Calls during a sync run once more after it. */
  sync(): Promise<void> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = this.syncOnce()
      .catch((error) => console.warn(`library sync failed: ${String(error)}`))
      .finally(() => {
        this.running = undefined
        if (this.again) {
          this.again = false
          void this.sync()
        }
      })
    return this.running
  }

  private async readViews(): Promise<Views> {
    return readFile(this.viewsFile, 'utf8').then(
      (text) => JSON.parse(text) as Views,
      () => ({}),
    )
  }

  private async syncOnce() {
    const manifest = LibraryManifest.parse(await this.get('/runner/library').then((r) => r.json()))
    this.memory = manifest.memory
    await mkdir(paths.state, { recursive: true, mode: 0o700 })
    await writeFile(this.memoryFile, JSON.stringify(manifest.memory), { mode: 0o600 })

    const views = await this.readViews()
    for (const id of this.added) views[id] ??= {}
    this.added.clear()
    try {
      await mkdir(LIBRARY_DIR, { recursive: true })
      await mkdir(STORE, { recursive: true, mode: 0o700 })
    } catch (error) {
      // On a cloud computer the folder comes from the root setup, which the API applies.
      return console.warn(`no library folder at ${LIBRARY_DIR} yet: ${String(error)}`)
    }
    await this.removeLegacy()

    // What each teammate may read. An API without access rules gives everyone everything.
    const access = manifest.access
    const wanted = new Map<string, LibraryManifest['files']>()
    for (const teammateId of Object.keys(views)) {
      const teammate = access?.teammates.find((t) => t.id === teammateId)
      if (access && !teammate) {
        // Archived or deleted: its mirror goes.
        await rm(libraryDirFor(teammateId), { recursive: true, force: true }).catch(() => undefined)
        delete views[teammateId]
        continue
      }
      wanted.set(
        teammateId,
        manifest.files.filter(
          (f) =>
            !access || !teammate || libraryAccessFor(f.path, teammate, access.folders) !== 'none',
        ),
      )
    }

    // The bytes every mirror needs, fetched once each.
    const needed = new Map<string, string>() // sha256 -> a file id to fetch it by
    for (const files of wanted.values()) for (const f of files) needed.set(f.sha256, f.id)
    let fetched = 0
    for (const [sha, id] of needed) if (await this.store(sha, id)) fetched++

    let changed = 0
    for (const [teammateId, files] of wanted) {
      const root = await this.viewRoot(teammateId).catch((error) => {
        console.warn(`library: no mirror for ${teammateId}: ${String(error)}`)
        return undefined
      })
      if (!root) continue
      const index = views[teammateId]!
      const keep = new Set<string>()
      for (const file of files) {
        const target = inside(root, file.path)
        if (!target || !(await exists(join(STORE, file.sha256)))) continue
        keep.add(file.path)
        if (index[file.path] === file.sha256 && (await exists(target))) continue
        await mkdir(dirname(target), { recursive: true, mode: 0o750 })
        const tmp = join(root, `.tmp-${randomUUID()}`)
        await link(join(STORE, file.sha256), tmp).catch(() =>
          copyFile(join(STORE, file.sha256), tmp),
        )
        await rename(tmp, target)
        index[file.path] = file.sha256
        changed++
      }
      for (const path of Object.keys(index)) {
        if (keep.has(path)) continue
        const target = inside(root, path)
        if (target) {
          await rm(target, { force: true })
          await pruneEmpty(dirname(target), root)
        }
        delete index[path]
        changed++
      }
    }

    // Bytes no mirror uses any more.
    for (const name of await readdir(STORE).catch(() => [])) {
      if (!needed.has(name)) await rm(join(STORE, name), { force: true })
    }
    await writeFile(this.viewsFile, JSON.stringify(views), { mode: 0o600 })
    if (changed > 0 || fetched > 0)
      console.log(
        `library: ${fetched} file(s) fetched, ${changed} change(s) across ${wanted.size} teammate mirror(s)`,
      )
  }

  /** Put a file's bytes in the store, unless they are there. True when fetched. */
  private async store(sha: string, fileId: string) {
    if (!/^[0-9a-f]{64}$/.test(sha)) return false
    const target = join(STORE, sha)
    if (await exists(target)) return false
    // A large file comes as a redirect to the bucket, where fetch does not send the token.
    const response = await this.get(`/runner/library/files/${encodeURIComponent(fileId)}`)
    if (!response.body) throw new Error(`the file ${fileId} came with no bytes`)
    // Written as it arrives, never held whole: a file can be hundreds of MB.
    const tmp = join(STORE, `.tmp-${randomUUID()}`)
    const hash = createHash('sha256')
    try {
      await pipeline(
        Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
        async function* (chunks: AsyncIterable<Buffer>) {
          for await (const chunk of chunks) {
            hash.update(chunk)
            yield chunk
          }
        },
        createWriteStream(tmp, { mode: 0o640 }),
      )
      if (hash.digest('hex') !== sha) {
        await rm(tmp, { force: true })
        return false // changed meanwhile
      }
      await rename(tmp, target)
    } catch (error) {
      await rm(tmp, { force: true })
      throw error
    }
    return true
  }

  /** A teammate's mirror folder: made by the root helper on a cloud computer, for its user's group. */
  private async viewRoot(teammateId: string) {
    const root = libraryDirFor(teammateId)
    if (await exists(root)) return root
    if (CLOUD)
      await run(
        'sudo',
        ['-n', '/usr/local/sbin/brigade-teammate', 'library-view', teammateUser(teammateId)],
        {
          cwd: '/',
        },
      )
    else await mkdir(root, { recursive: true, mode: 0o700 })
    return root
  }

  /** The single mirror runners kept before protocol 13: removed, files and index. */
  private async removeLegacy() {
    const legacy = await readFile(this.legacyIndexFile, 'utf8').then(
      (text) => JSON.parse(text) as Index,
      () => undefined,
    )
    if (!legacy) return
    for (const path of Object.keys(legacy)) {
      const target = inside(LIBRARY_DIR, path)
      if (!target) continue
      await rm(target, { force: true })
      await pruneEmpty(dirname(target), LIBRARY_DIR)
    }
    await rm(this.legacyIndexFile, { force: true })
    console.log('library: removed the shared mirror; each teammate now has its own')
  }

  private async get(path: string) {
    const response = await fetch(new URL(path, this.config.apiUrl), {
      headers: { authorization: `Bearer ${this.config.token}` },
    })
    if (!response.ok) throw new Error(`${path}: ${response.status}`)
    return response
  }

  /** Remove leftovers from an interrupted sync. */
  async cleanTemp() {
    const roots = [
      LIBRARY_DIR,
      STORE,
      ...Object.keys(await this.readViews()).map((id) => libraryDirFor(id)),
    ]
    for (const root of roots) {
      const names = await readdir(root).catch(() => [])
      await Promise.all(
        names.filter((n) => n.startsWith('.tmp-')).map((n) => rm(join(root, n), { force: true })),
      )
    }
  }
}

/** The path of a library path under `root`, or undefined if it would leave it. */
function inside(root: string, path: string) {
  const target = resolve(root, path)
  const rel = relative(root, target)
  return rel && !rel.startsWith('..') && !rel.startsWith('/') ? target : undefined
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  )

/** Remove empty folders up to `root`. */
async function pruneEmpty(dir: string, root: string) {
  while (dir.startsWith(`${root}/`)) {
    if ((await readdir(dir).catch(() => ['?'])).length > 0) return
    await rmdir(dir).catch(() => undefined)
    dir = dirname(dir)
  }
}
