// The workspace library, mirrored on this computer, and the memory teammates
// load. The API is the source; this copy follows it. On a cloud computer the
// mirror is readable by every teammate user and writable only by the runner.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { LibraryManifest } from '@brigade/contracts'
import { CLOUD, HOME, paths, type RunnerConfig } from './config.js'

/** Where the library is mirrored. Teammates read it there. */
export const LIBRARY_DIR = CLOUD ? '/var/lib/brigade/library' : join(HOME, 'library')
/** Fetch again now and then, in case a change notice was missed. */
const RESYNC_MS = 15 * 60_000

type Index = Record<string, string> // path -> sha256 of the mirrored copy

export class Library {
  private memory: LibraryManifest['memory'] = { workspace: '', teammates: {} }
  private running: Promise<void> | undefined
  private again = false
  private readonly indexFile = join(paths.state, 'library.json')
  private readonly memoryFile = join(paths.state, 'memory.json')

  constructor(private readonly config: RunnerConfig) {
    // Memory from the last sync, until the first one of this process.
    void readFile(this.memoryFile, 'utf8')
      .then((text) => (this.memory = LibraryManifest.shape.memory.parse(JSON.parse(text))))
      .catch(() => undefined)
    setInterval(() => void this.sync(), RESYNC_MS).unref()
  }

  /** The memory a teammate loads: the workspace's and its own. */
  memoryFor(teammateId: string) {
    return { workspace: this.memory.workspace, teammate: this.memory.teammates[teammateId] ?? '' }
  }

  /** Bring the mirror and memory up to date. Calls during a sync run once more after it. */
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

  private async syncOnce() {
    const manifest = LibraryManifest.parse(await this.get('/runner/library').then((r) => r.json()))
    this.memory = manifest.memory
    await mkdir(paths.state, { recursive: true, mode: 0o700 })
    await writeFile(this.memoryFile, JSON.stringify(manifest.memory), { mode: 0o600 })

    const index: Index = await readFile(this.indexFile, 'utf8').then(
      (text) => JSON.parse(text) as Index,
      () => ({}),
    )
    try {
      await mkdir(LIBRARY_DIR, { recursive: true })
    } catch (error) {
      // On a cloud computer the folder comes from the root setup, which the API applies.
      return console.warn(`no library folder at ${LIBRARY_DIR} yet: ${String(error)}`)
    }
    const wanted = new Set<string>()
    let changed = 0
    for (const file of manifest.files) {
      const target = this.inside(file.path)
      if (!target) continue
      wanted.add(file.path)
      if (index[file.path] === file.sha256 && (await exists(target))) continue
      const response = await this.get(`/runner/library/files/${encodeURIComponent(file.id)}`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) continue // changed meanwhile
      await mkdir(dirname(target), { recursive: true, mode: 0o750 })
      const tmp = join(LIBRARY_DIR, `.tmp-${randomUUID()}`)
      await writeFile(tmp, bytes, { mode: 0o640 })
      await rename(tmp, target)
      index[file.path] = file.sha256
      changed++
    }
    for (const path of Object.keys(index)) {
      if (wanted.has(path)) continue
      const target = this.inside(path)
      if (target) {
        await rm(target, { force: true })
        await pruneEmpty(dirname(target))
      }
      delete index[path]
      changed++
    }
    await writeFile(this.indexFile, JSON.stringify(index), { mode: 0o600 })
    if (changed > 0) console.log(`library: ${changed} file(s) updated, ${wanted.size} in all`)
  }

  /** The mirror path of a library path, or undefined if it would leave the folder. */
  private inside(path: string) {
    const target = resolve(LIBRARY_DIR, path)
    const rel = relative(LIBRARY_DIR, target)
    return rel && !rel.startsWith('..') && !rel.startsWith('/') ? target : undefined
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
    const names = await readdir(LIBRARY_DIR).catch(() => [])
    await Promise.all(
      names
        .filter((n) => n.startsWith('.tmp-'))
        .map((n) => rm(join(LIBRARY_DIR, n), { force: true })),
    )
  }
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  )

/** Remove empty folders up to the library's own. */
async function pruneEmpty(dir: string) {
  while (dir.startsWith(`${LIBRARY_DIR}/`)) {
    if ((await readdir(dir).catch(() => ['?'])).length > 0) return
    await rmdir(dir).catch(() => undefined)
    dir = dirname(dir)
  }
}
