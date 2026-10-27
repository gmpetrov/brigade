// The large parts of a thread's spec (SPEC_PARTS_PROTOCOL): a command names its connectors,
// skills, project and design systems by the SHA-256 of their JSON, and they are fetched from the
// API once (GET /runner/spec-parts/<sha256>), then kept here. Filled in before a command is
// handled, so nothing past this reads a spec with its parts missing.
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ThreadSpec, type ApiToRunner } from '@brigade/contracts'
import { HOME, type RunnerConfig } from './config.js'

const CACHE_DIR = join(HOME, 'spec-parts')
/** Parts no command named for this long are removed. */
const CACHE_DAYS = 14
/** A fetch that failed is tried again after these waits: the API restarting, the network. */
const RETRIES_MS = [1000, 3000, 10_000, 30_000]

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

export class SpecParts {
  /** Parts read lately, by hash, as parsed JSON. */
  private readonly memory = new Map<string, unknown>()

  constructor(
    private readonly config: Pick<RunnerConfig, 'apiUrl' | 'token'>,
    private readonly dir = CACHE_DIR,
    private readonly retriesMs = RETRIES_MS,
  ) {}

  /** The command with every spec it carries whole. */
  async fill<T extends ApiToRunner>(message: T): Promise<T> {
    if (message.type === 'welcome') {
      const resume = message.resume && (await Promise.all(message.resume.map((s) => this.spec(s))))
      const requeue =
        message.requeue && (await Promise.all(message.requeue.map((p) => this.fill(p))))
      return {
        ...message,
        ...(resume ? { resume } : {}),
        ...(requeue ? { requeue } : {}),
      }
    }
    if (!('thread' in message)) return message
    const thread = await this.spec(message.thread)
    if (message.type !== 'thread.prompt') return { ...message, thread }
    return { ...message, thread, then: await Promise.all(message.then.map((s) => this.spec(s))) }
  }

  /** The spec with its parts filled in. */
  async spec(spec: ThreadSpec): Promise<ThreadSpec> {
    if (!spec.parts) return spec
    const { parts, ...rest } = spec
    const filled: Record<string, unknown> = { ...rest }
    for (const [name, hash] of Object.entries(parts)) filled[name] = await this.part(hash)
    return ThreadSpec.parse(filled)
  }

  private async part(hash: string): Promise<unknown> {
    const hit = this.memory.get(hash)
    if (hit !== undefined) return hit
    const file = join(this.dir, `${hash}.json`)
    let text = await readFile(file, 'utf8').catch(() => null)
    if (text !== null && sha256(text) === hash) {
      const now = new Date()
      await utimes(file, now, now).catch(() => undefined)
    } else {
      text = await this.fetch(hash)
      await mkdir(this.dir, { recursive: true, mode: 0o700 })
      await writeFile(file, text, { mode: 0o600 })
    }
    const value: unknown = JSON.parse(text)
    if (this.memory.size > 200) this.memory.clear()
    this.memory.set(hash, value)
    return value
  }

  private async fetch(hash: string) {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(new URL(`/runner/spec-parts/${hash}`, this.config.apiUrl), {
          headers: { authorization: `Bearer ${this.config.token}` },
        })
        if (!response.ok) throw new Error(`the API answered ${response.status}`)
        const text = await response.text()
        if (sha256(text) !== hash) throw new Error('it changed on the way')
        return text
      } catch (error) {
        const wait = this.retriesMs[attempt]
        if (wait === undefined)
          throw new Error(`could not fetch the thread's spec part ${hash}: ${String(error)}`)
        await new Promise((resolve) => setTimeout(resolve, wait))
      }
    }
  }

  /** Remove parts no command named for a while. */
  async cleanCache() {
    const names = await readdir(this.dir).catch(() => [])
    const before = Date.now() - CACHE_DAYS * 24 * 3600_000
    for (const name of names) {
      const file = join(this.dir, name)
      const info = await stat(file).catch(() => null)
      if (info && info.mtimeMs < before) await rm(file, { force: true })
    }
  }
}
