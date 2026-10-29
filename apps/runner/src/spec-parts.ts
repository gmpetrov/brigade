// The large parts of a thread's spec (SPEC_PARTS_PROTOCOL): a command names its connectors,
// skills, project and design systems by the SHA-256 of their JSON, and they are fetched from the
// API once (GET /runner/spec-parts/<sha256>), then kept here. Its Apps' operations too
// (CATALOG_PROTOCOL): each connector names its App's catalog by a version, fetched once (GET
// /runner/catalogs/<connectionId>) and kept while that version holds. Filled in before a
// command is handled, so nothing past this reads a spec with its parts missing.
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CATALOG_INCOMPLETE_HEADER,
  ConnectorGrant,
  ThreadSpec,
  type ApiToRunner,
} from '@brigade/contracts'
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
  /** Catalogs read lately, and being read, by connection, scope and version. */
  private readonly catalogs = new Map<string, ConnectorGrant['operations']>()
  private readonly cataloging = new Map<string, Promise<ConnectorGrant['operations']>>()

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

  /** The spec with its parts, then its Apps' catalogs, filled in. */
  async spec(spec: ThreadSpec): Promise<ThreadSpec> {
    let whole = spec
    if (spec.parts) {
      const { parts, ...rest } = spec
      const filled: Record<string, unknown> = { ...rest }
      for (const [name, hash] of Object.entries(parts)) filled[name] = await this.part(hash)
      whole = ThreadSpec.parse(filled)
    }
    if (!whole.connectors.some((c) => c.catalog)) return whole
    const connectors = await Promise.all(
      whole.connectors.map(async (grant) =>
        grant.catalog ? { ...grant, operations: await this.catalog(grant) } : grant,
      ),
    )
    return { ...whole, connectors }
  }

  /**
   * A connector's operations, from its App's catalog: kept, or fetched. One the API will not
   * give (the connection gone since) leaves the App without tools in this turn, as a signed-out
   * one does; one it could not give now holds the command, as a part does.
   */
  private catalog(grant: ConnectorGrant): Promise<ConnectorGrant['operations']> {
    const key = `${grant.connectionId}:${grant.scope}:${grant.catalog!.version}`
    const hit = this.catalogs.get(key)
    if (hit) return Promise.resolve(hit)
    const pending = this.cataloging.get(key)
    if (pending) return pending
    const read = this.readCatalog(grant, key)
      .then(({ operations, keep }) => {
        if (this.catalogs.size > 200) this.catalogs.clear()
        if (keep) this.catalogs.set(key, operations)
        return operations
      })
      .finally(() => this.cataloging.delete(key))
    this.cataloging.set(key, read)
    return read
  }

  private async readCatalog(grant: ConnectorGrant, key: string) {
    const file = join(this.dir, `catalog-${sha256(key)}.json`)
    const kept = await readFile(file, 'utf8')
      .then((text) => JSON.parse(text) as unknown)
      .catch(() => null)
    if (Array.isArray(kept)) {
      const now = new Date()
      await utimes(file, now, now).catch(() => undefined)
      return { operations: ConnectorGrant.shape.operations.parse(kept), keep: true }
    }
    const path = `/runner/catalogs/${encodeURIComponent(grant.connectionId)}?scope=${grant.scope}&version=${encodeURIComponent(grant.catalog!.version)}`
    let text: string
    let complete = true
    try {
      text = await this.fetch(path, (_, response) => {
        complete = response.headers.get(CATALOG_INCOMPLETE_HEADER) !== '1'
      })
    } catch (error) {
      if (!(error instanceof Refused)) throw error
      console.warn(`${grant.kind} (${grant.connectionId}): no tools in this turn: ${error.message}`)
      return { operations: [], keep: false }
    }
    const operations = ConnectorGrant.shape.operations.parse(JSON.parse(text))
    // Not listed now (its server down): for this turn only, asked again at the next.
    if (!complete) {
      console.warn(`${grant.kind} (${grant.connectionId}): its tools could not be listed now`)
      return { operations, keep: false }
    }
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
      .then(() => writeFile(file, text, { mode: 0o600 }))
      .catch((error: unknown) => console.warn(`catalog ${key} not kept: ${String(error)}`))
    return { operations, keep: true }
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
      text = await this.fetchPart(hash)
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

  private async fetchPart(hash: string) {
    try {
      const text = await this.fetch(`/runner/spec-parts/${hash}`, (body) => {
        // As hashed: anything else changed on the way.
        if (sha256(body) !== hash) throw new Error('it changed on the way')
      })
      return text
    } catch (error) {
      throw new Error(`could not fetch the thread's spec part ${hash}: ${String(error)}`)
    }
  }

  /** A path of the API, tried again while the API may answer otherwise; Refused once it will not. */
  private async fetch(path: string, check?: (body: string, response: Response) => void) {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(new URL(path, this.config.apiUrl), {
          headers: { authorization: `Bearer ${this.config.token}` },
          signal: AbortSignal.timeout(this.attemptMs),
        })
        // Asked again, it would answer the same; a busy or restarting API may not.
        if (!response.ok && response.status < 500 && ![408, 429].includes(response.status))
          throw new Refused(`the API answered ${response.status}`)
        if (!response.ok) throw new Error(`the API answered ${response.status}`)
        const text = await response.text()
        check?.(text, response)
        return text
      } catch (error) {
        const wait = error instanceof Refused ? undefined : this.retriesMs[attempt]
        if (wait === undefined) throw error
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
