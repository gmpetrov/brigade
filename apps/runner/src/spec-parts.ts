// The large parts of a thread's spec (SPEC_PARTS_PROTOCOL): a command names its connectors,
// skills, project and design systems by the SHA-256 of their JSON, and they are fetched from the
// API once (GET /runner/spec-parts/<sha256>), then kept here. Filled in before a command is
// handled, so nothing past this reads a spec with its parts missing.
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ThreadSpec, type ApiToRunner } from '@brigade/contracts'
import { HOME, type RunnerConfig } from './config.js'
import { NotTaken } from './connection.js'

const CACHE_DIR = join(HOME, 'spec-parts')
/** Parts no command named for this long are removed. */
const CACHE_DAYS = 14
/** A fetch that failed is tried again after these waits: the API restarting, the network. */
const RETRIES_MS = [1000, 3000, 10_000]
/** Longest one try at a part may take, its body included: a stalled one holds every command. */
const ATTEMPT_MS = 30_000

/** The API will not have it however often it is asked (unknown token, part gone, bad hash). */
class Refused extends Error {}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

export class SpecParts {
  /** Parts read lately, by hash, as parsed JSON. */
  private readonly memory = new Map<string, unknown>()
  /** Parts being read or fetched, by hash: specs naming the same one wait for one fetch. */
  private readonly reading = new Map<string, Promise<unknown>>()

  constructor(
    private readonly config: Pick<RunnerConfig, 'apiUrl' | 'token'>,
    private readonly dir = CACHE_DIR,
    private readonly retriesMs = RETRIES_MS,
    private readonly attemptMs = ATTEMPT_MS,
  ) {}

  /**
   * Hand commands on with their specs filled in, one after the other: one that needs nothing
   * fetched still waits for the one before, so the order holds. One whose parts did not come is
   * not taken (NotTaken): the API sends it again.
   */
  inOrder(onCommand: (message: ApiToRunner) => unknown) {
    let filling: Promise<unknown> = Promise.resolve()
    return (message: ApiToRunner) => {
      const filled = filling.then(() => this.fill(message))
      filling = filled.catch(() => undefined)
      return filled.then(onCommand, (error: unknown) => {
        throw new NotTaken(String(error))
      })
    }
  }

  /**
   * The command with every spec it carries whole. A welcome goes on without a turn or queued
   * message whose spec did not come: the runner then closes that turn, or cancels that message,
   * as one the API could not say how to continue; the rest of the welcome (its restore) holds.
   */
  async fill<T extends ApiToRunner>(message: T): Promise<T> {
    if (message.type === 'welcome') {
      const kept = async <V>(items: V[] | undefined, fill: (item: V) => Promise<V>) => {
        if (!items) return undefined
        const settled = await Promise.allSettled(items.map(fill))
        for (const s of settled)
          if (s.status === 'rejected') console.warn(`welcome: ${String(s.reason)}; left out`)
        return settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []))
      }
      const resume = await kept(message.resume, (s) => this.spec(s))
      const requeue = await kept(message.requeue, (p) => this.fill(p))
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

  private part(hash: string): Promise<unknown> {
    const hit = this.memory.get(hash)
    if (hit !== undefined) return Promise.resolve(hit)
    const pending = this.reading.get(hash)
    if (pending) return pending
    const read = this.read(hash).finally(() => this.reading.delete(hash))
    this.reading.set(hash, read)
    return read
  }

  private async read(hash: string): Promise<unknown> {
    const file = join(this.dir, `${hash}.json`)
    let text = await readFile(file, 'utf8').catch(() => null)
    if (text !== null && sha256(text) === hash) {
      const now = new Date()
      await utimes(file, now, now).catch(() => undefined)
    } else {
      text = await this.fetch(hash)
      // Kept for next time if the disk lets it (it may be full): this command has it either way.
      await mkdir(this.dir, { recursive: true, mode: 0o700 })
        .then(() => writeFile(file, text!, { mode: 0o600 }))
        .catch((error: unknown) => console.warn(`spec part ${hash} not kept: ${String(error)}`))
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
          signal: AbortSignal.timeout(this.attemptMs),
        })
        // Asked again, it would answer the same; a busy or restarting API may not.
        if (!response.ok && response.status < 500 && ![408, 429].includes(response.status))
          throw new Refused(`the API answered ${response.status}`)
        if (!response.ok) throw new Error(`the API answered ${response.status}`)
        const text = await response.text()
        if (sha256(text) !== hash) throw new Error('it changed on the way')
        return text
      } catch (error) {
        const wait = error instanceof Refused ? undefined : this.retriesMs[attempt]
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
