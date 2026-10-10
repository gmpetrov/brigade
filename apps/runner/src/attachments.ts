// A thread's files on this computer. The API keeps them; before a teammate's
// turn the runner fetches the ones its working folder lacks and puts them
// there, as the teammate's user on a cloud computer. Each is put once: a
// teammate that edits or removes its copy keeps that.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { ATTACHMENTS_DIR, type ThreadAttachmentRef } from '@brigade/contracts'
import { HOME, paths, type RunnerConfig } from './config.js'

/** Fetched files, shared by the teammates of a thread: one download each. Only the runner reads it. */
const CACHE_DIR = join(HOME, 'attachments')
/** Cached files unused this long are removed. */
const CACHE_DAYS = 7
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/

/** Where a teammate works on a thread: its folder, and its user on a cloud computer. */
export type Folder = { key: string; workDir: string; runAs?: string }

export class Attachments {
  constructor(private readonly config: RunnerConfig) {}

  /**
   * Put the thread's files in a teammate's working folder, those not put there
   * before. Returns what could not be, for the thread to say.
   */
  async deliver(refs: ThreadAttachmentRef[], folder: Folder): Promise<string[]> {
    const ready = refs.filter((r) => r.status === 'ready')
    if (ready.length === 0) return []
    const indexFile = join(paths.state, 'attachments', `${folder.key}.json`)
    const index: Record<string, string> = await readFile(indexFile, 'utf8').then(
      (text) => JSON.parse(text) as Record<string, string>,
      () => ({}),
    )
    const failed: string[] = []
    let changed = false
    for (const ref of ready) {
      if (index[ref.path] === ref.id) continue
      const target = inside(folder.workDir, ref.path)
      if (!target || !SAFE_ID.test(ref.id)) {
        failed.push(`${ref.name}: not a path in the working folder`)
        continue
      }
      try {
        await writeAs(target, await this.bytes(ref), folder.runAs)
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

  /** Send a teammate's file to the API, to go with a connector call. Returns its id there. */
  async upload(input: { sessionId: string; teammateId: string; name: string; bytes: Buffer }) {
    const query = new URLSearchParams({
      sessionId: input.sessionId,
      teammateId: input.teammateId,
      name: input.name,
    })
    const response = await fetch(new URL(`/runner/attachments?${query}`, this.config.apiUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.token}`,
        'content-type': 'application/octet-stream',
      },
      body: new Uint8Array(input.bytes),
    })
    const body = (await response.json().catch(() => ({}))) as { id?: string; error?: string }
    if (!response.ok || !body.id)
      throw new Error(`Could not send ${input.name}: ${body.error ?? response.status}`)
    return body.id
  }

  /** The file's bytes, from the cache or the API, checked against its SHA-256. */
  private async bytes(ref: ThreadAttachmentRef) {
    const cached = join(CACHE_DIR, ref.id)
    const hit = await readFile(cached).catch(() => null)
    if (hit && sha256(hit) === ref.sha256) return hit
    const response = await fetch(
      new URL(`/runner/attachments/${encodeURIComponent(ref.id)}`, this.config.apiUrl),
      { headers: { authorization: `Bearer ${this.config.token}` } },
    )
    if (!response.ok) throw new Error(`the API refused it (${response.status})`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (sha256(bytes) !== ref.sha256) throw new Error('it changed on the way; try again')
    await mkdir(CACHE_DIR, { recursive: true, mode: 0o700 })
    await writeFile(cached, bytes, { mode: 0o600 })
    return bytes
  }

  /** Remove cached files nobody used for a while. */
  async cleanCache() {
    const names = await readdir(CACHE_DIR).catch(() => [])
    const before = Date.now() - CACHE_DAYS * 24 * 3600_000
    for (const name of names) {
      const file = join(CACHE_DIR, name)
      const info = await stat(file).catch(() => null)
      if (info && info.atimeMs < before && info.mtimeMs < before) await rm(file, { force: true })
    }
  }
}

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

/** The path inside the working folder's attachments folder, or undefined if it would leave it. */
function inside(workDir: string, path: string) {
  const target = resolve(workDir, path)
  const rel = relative(join(workDir, ATTACHMENTS_DIR), target)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? target : undefined
}

/** Write a file readable by its owner and group, never executable; as `runAs` when given. */
async function writeAs(target: string, bytes: Uint8Array, runAs?: string) {
  if (!runAs) {
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, bytes, { mode: 0o644 })
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
    child.once('error', fail)
    child.once('close', (code) =>
      code === 0 ? done() : fail(new Error(`could not write it (${code})`)),
    )
    child.stdin.end(bytes)
  })
}
