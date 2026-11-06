// A thread's files on this computer. The API keeps them; before a teammate's
// turn the runner fetches the ones its working folder lacks and puts them
// there, as the teammate's user on a cloud computer. Each is put once: a
// teammate that edits or removes its copy keeps that. A folder that came from
// another computer (a move) already holds them: those found as they are stay,
// without being fetched again. Skills' files are fetched the same way, by
// their SHA-256, and cached alike.
//
// A file fetched is kept in the runner's cache a week, for the thread's other teammates: one
// download each. A large one (a video) is not: the shared disk would hold it twice, the cache's
// copy and the teammate's. It streams from storage straight into the teammate's folder, hashed on
// the way, under a name of its own beside its place, then moves there once its SHA-256 matches:
// the disk holds it once. Another teammate of the thread fetches it again, which costs nothing.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream } from 'node:stream/web'
import { ATTACHMENTS_DIR, type ThreadAttachmentRef } from '@brigade/contracts'
import { HOME, paths, type RunnerConfig } from './config.js'
import { ensureUser } from './teammates.js'
import { answer, apiPost, sha256Hex, upload, type Ticket } from './uploads.js'

/** Fetched files, shared by the teammates of a thread: one download each. Only the runner reads it. */
const CACHE_DIR = join(HOME, 'attachments')
/** Cached files unused this long are removed. */
const CACHE_DAYS = 7
/** From this size on, a file is not kept in the cache: it streams into the teammate's folder alone. */
export const LARGE_FILE = 100 * 1024 ** 2
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/

/** Where a teammate works on a thread: its folder, and its user on a cloud computer. */
export type Folder = { key: string; workDir: string; runAs?: string }

export class Attachments {
  private readonly large: number
  /**
   * Each folder's deliveries, one after the other: a turn's and a call's at once would fetch a
   * file twice, write its temporary copy together, and each save its own index over the other's.
   */
  private readonly delivering = new Map<string, Promise<unknown>>()

  constructor(
    private readonly config: RunnerConfig,
    /** Tests: from what size a file is not cached. */
    options: { largeFile?: number } = {},
  ) {
    this.large = options.largeFile ?? LARGE_FILE
  }

  /**
   * Put the thread's files in a teammate's working folder, those not put there
   * before. Returns what could not be, for the thread to say.
   */
  deliver(
    refs: ThreadAttachmentRef[],
    folder: Folder,
    /** Told once, before the first file is fetched: the turn waits for it. */
    fetching?: () => void,
  ): Promise<string[]> {
    const before = this.delivering.get(folder.key) ?? Promise.resolve()
    const next = before.then(() => this.deliverNow(refs, folder, fetching))
    const settled = next.then(
      () => undefined,
      () => undefined,
    )
    this.delivering.set(folder.key, settled)
    void settled.then(() => {
      if (this.delivering.get(folder.key) === settled) this.delivering.delete(folder.key)
    })
    return next
  }

  private async deliverNow(
    refs: ThreadAttachmentRef[],
    folder: Folder,
    fetching?: () => void,
  ): Promise<string[]> {
    const ready = refs.filter((r) => r.status === 'ready')
    if (ready.length === 0) return []
    const indexFile = join(paths.state, 'attachments', `${folder.key}.json`)
    const index: Record<string, string> = await readFile(indexFile, 'utf8').then(
      (text) => JSON.parse(text) as Record<string, string>,
      () => ({}),
    )
    const failed: string[] = []
    let changed = false
    const missing = ready.filter((ref) => index[ref.path] !== ref.id)
    // A teammate's first turn places its files before its harness starts: its user comes first.
    if (missing.length > 0 && folder.runAs) await ensureUser(folder.runAs)
    let told = false
    for (const ref of missing) {
      const target = inside(folder.workDir, ref.path)
      if (!target || !SAFE_ID.test(ref.id)) {
        failed.push(`${ref.name}: not a path in the working folder`)
        continue
      }
      const large = ref.size >= this.large
      try {
        // What a cut download left beside it goes, whatever comes next.
        if (large) await removeAs(partialOf(target, ref), folder.runAs)
        // There already, as it is (the folder came from the computer it left): put, without a download.
        if ((await sha256As(target, folder.runAs)) !== ref.sha256) {
          if (!told) fetching?.()
          told = true
          if (large) await this.stream(ref, target, folder.runAs)
          else await writeAs(target, await this.cached(ref), folder.runAs)
        }
        index[ref.path] = ref.id
        changed = true
      } catch (error) {
        failed.push(`${ref.path}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (changed) {
      await mkdir(dirname(indexFile), { recursive: true, mode: 0o700 })
      await writeFile(indexFile, JSON.stringify(index), { mode: 0o600 })
    }
    return failed
  }

  /**
   * Send a teammate's file to go with a connector call: straight to the bucket at a
   * URL the API signs, then checked there. Returns its id.
   */
  async upload(input: { sessionId: string; teammateId: string; name: string; bytes: Buffer }) {
    const { bytes, ...rest } = input
    const sha256 = sha256Hex(bytes)
    try {
      const { id } = await upload(this.config, bytes, {
        start: async () =>
          answer<Ticket & { id: string }>(
            await apiPost(this.config, '/runner/attachments/uploads', {
              ...rest,
              size: bytes.length,
              sha256,
            }),
            'the file',
          ),
        complete: async (ticket) =>
          answer<{ id: string }>(
            await apiPost(
              this.config,
              `/runner/attachments/${encodeURIComponent(ticket.id)}/complete`,
              { sha256 },
            ),
            'the file',
          ),
      })
      return id
    } catch (error) {
      throw new Error(
        `Could not send ${input.name}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /** The file's bytes as they come from the API, or from the bucket it redirects to. */
  private async download(ref: ThreadAttachmentRef) {
    // A large file comes as a redirect to the bucket, where fetch does not send the token.
    const response = await fetch(
      new URL(`/runner/attachments/${encodeURIComponent(ref.id)}`, this.config.apiUrl),
      { headers: { authorization: `Bearer ${this.config.token}` } },
    )
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`the API refused it (${response.status})`)
    }
    return response.body
  }

  /**
   * A large file, from storage straight into the teammate's folder: written as it comes beside its
   * place, hashed on the way, then moved there once it matches; nothing of it left otherwise. No
   * copy in the cache, nor one a runner before this one kept there: the shared disk holds it once.
   */
  private async stream(ref: ThreadAttachmentRef, target: string, runAs?: string) {
    await rm(join(CACHE_DIR, ref.id), { force: true })
    const body = await this.download(ref)
    const partial = partialOf(target, ref)
    const hash = createHash('sha256')
    let size = 0
    const hashed = Readable.from(
      (async function* () {
        for await (const chunk of Readable.fromWeb(body as ReadableStream<Uint8Array>)) {
          hash.update(chunk as Buffer)
          size += (chunk as Buffer).length
          yield chunk as Buffer
        }
      })(),
    )
    try {
      await writeAs(partial, hashed, runAs)
      if (size !== ref.size || hash.digest('hex') !== ref.sha256)
        throw new Error('it changed on the way; try again')
      await moveAs(partial, target, runAs)
    } catch (error) {
      hashed.destroy()
      await removeAs(partial, runAs).catch(() => undefined)
      throw error
    }
  }

  /**
   * The file in the cache, fetched from the API if it lacks it, checked against
   * its SHA-256. Written as it arrives.
   */
  private async cached(ref: ThreadAttachmentRef) {
    const cached = join(CACHE_DIR, ref.id)
    if ((await fileSha256(cached)) === ref.sha256) return cached
    const body = await this.download(ref)
    await mkdir(CACHE_DIR, { recursive: true, mode: 0o700 })
    const partial = `${cached}.part`
    const hash = createHash('sha256')
    try {
      await pipeline(
        Readable.fromWeb(body as ReadableStream<Uint8Array>),
        async function* (chunks: AsyncIterable<Buffer>) {
          for await (const chunk of chunks) {
            hash.update(chunk)
            yield chunk
          }
        },
        createWriteStream(partial, { mode: 0o600 }),
      )
      if (hash.digest('hex') !== ref.sha256) throw new Error('it changed on the way; try again')
      await rename(partial, cached)
    } catch (error) {
      await rm(partial, { force: true })
      throw error
    }
    return cached
  }

  /** A skill's file, by its SHA-256: from the cache, or the API (once per computer). */
  async skillFile(hash: string) {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('not a SHA-256')
    const cached = join(CACHE_DIR, `skill-${hash}`)
    const hit = await readFile(cached).catch(() => null)
    if (hit && sha256(hit) === hash) return hit
    const response = await fetch(new URL(`/runner/skill-files/${hash}`, this.config.apiUrl), {
      headers: { authorization: `Bearer ${this.config.token}` },
    })
    if (!response.ok) throw new Error(`the API refused it (${response.status})`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (sha256(bytes) !== hash) throw new Error('it changed on the way; try again')
    await mkdir(CACHE_DIR, { recursive: true, mode: 0o700 })
    await writeFile(cached, bytes, { mode: 0o600 })
    return bytes
  }

  /**
   * Remove cached files nobody used for a while, and any large one a runner before this one kept,
   * whenever it was used: this one never reads them, and they are a second copy of a file already
   * in a teammate's folder.
   */
  async cleanCache() {
    const names = await readdir(CACHE_DIR).catch(() => [])
    const before = Date.now() - CACHE_DAYS * 24 * 3600_000
    for (const name of names) {
      const file = join(CACHE_DIR, name)
      const info = await stat(file).catch(() => null)
      if (!info) continue
      const large = !name.startsWith('skill-') && info.size >= this.large
      if (large || (info.atimeMs < before && info.mtimeMs < before)) await rm(file, { force: true })
    }
  }
}

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

/** A file's SHA-256, read in chunks; null when it is missing. */
async function fileSha256(file: string) {
  const hash = createHash('sha256')
  try {
    for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  } catch {
    return null
  }
  return hash.digest('hex')
}

/** A file's SHA-256, read as `runAs` when given; null when it is missing or unreadable. */
async function sha256As(file: string, runAs?: string) {
  if (!runAs) return fileSha256(file)
  return new Promise<string | null>((done) => {
    const hash = createHash('sha256')
    const child = spawn('sudo', ['-n', '-u', runAs, '--', 'cat', '--', file], {
      cwd: '/',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    child.stdout.on('data', (chunk: Buffer) => hash.update(chunk))
    child.once('error', () => done(null))
    child.once('close', (code) => done(code === 0 ? hash.digest('hex') : null))
  })
}

/** The path inside the working folder's attachments folder, or undefined if it would leave it. */
function inside(workDir: string, path: string) {
  const target = resolve(workDir, path)
  const rel = relative(join(workDir, ATTACHMENTS_DIR), target)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? target : undefined
}

/**
 * Where a large file is written as it comes: beside its place, under a name of its own (its id's,
 * so a download cut short is written over by the next, never left to pile up).
 */
const partialOf = (target: string, ref: Pick<ThreadAttachmentRef, 'id'>) =>
  join(dirname(target), `.brigade-${ref.id}.part`)

/** Run `sudo -u runAs -- …args`, from /; fails with `what` and its exit code. */
function sudoAs(runAs: string, args: string[], what: string) {
  return new Promise<void>((done, fail) => {
    const child = spawn('sudo', ['-n', '-u', runAs, '--', ...args], {
      cwd: '/',
      stdio: 'ignore',
    })
    child.once('error', fail)
    child.once('close', (code) => (code === 0 ? done() : fail(new Error(`${what} (${code})`))))
  })
}

/** Move a file over another of the same folder, as `runAs` when given. */
async function moveAs(from: string, to: string, runAs?: string) {
  if (!runAs) return rename(from, to)
  await sudoAs(runAs, ['mv', '-f', '-T', '--', from, to], 'could not put it in place')
}

/** Remove a file if it is there, as `runAs` when given. */
async function removeAs(file: string, runAs?: string) {
  if (!runAs) return rm(file, { force: true })
  await sudoAs(runAs, ['rm', '-f', '--', file], 'could not remove what a download left')
}

/**
 * Write a file there from a cached file or a stream, readable by its owner and group, never
 * executable; as `runAs` when given.
 */
async function writeAs(target: string, source: string | Readable, runAs?: string) {
  if (!runAs) {
    await mkdir(dirname(target), { recursive: true })
    if (typeof source === 'string') await copyFile(source, target)
    else await pipeline(source, createWriteStream(target))
    await chmod(target, 0o644)
    return
  }
  await new Promise<void>((done, fail) => {
    const child = spawn(
      'sudo',
      [
        '-n',
        '-u',
        runAs,
        '--',
        'sh',
        '-c',
        'mkdir -p -- "$(dirname -- "$0")" && cat > "$0" && chmod 644 -- "$0"',
        target,
      ],
      { cwd: '/', stdio: ['pipe', 'ignore', 'ignore'] },
    )
    const input = typeof source === 'string' ? createReadStream(source) : source
    let cut: Error | undefined
    child.once('error', (error) => {
      input.destroy()
      fail(error)
    })
    child.once('close', (code) => {
      // Whatever it had not read yet goes: a download is not left open behind it.
      input.destroy()
      if (cut) fail(cut)
      else if (code === 0) done()
      else fail(new Error(`could not write it (${code})`))
    })
    // sudo that fails (an unknown user, say) exits without reading: its close says why.
    child.stdin.on('error', () => undefined)
    input.once('error', (error: Error) => {
      cut = error
      child.kill()
    })
    input.pipe(child.stdin)
  })
}
