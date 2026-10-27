// The API's platform on Node.js (see ./types.ts).
import { createHash } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import WebSocket from 'ws'
import { env } from '../config.js'
import type { HubCall, HubStub, RunnerBundleFile, Upstream, UpstreamEvents } from './types.js'

export { upgradeWebSocket } from '@hono/node-server'

/** A request body of exactly `size` bytes, sent with that length (undici sends the header given). */
export const fixedLength = (body: ReadableStream<Uint8Array>, size: number) => ({
  body,
  headers: { 'content-length': String(size) },
})

export function connectSocket(
  url: string,
  init: { protocol: string; headers: Record<string, string> },
  events: UpstreamEvents,
): Upstream {
  const socket = new WebSocket(url.replace(/^http/, 'ws'), init.protocol, {
    headers: init.headers,
  })
  socket.binaryType = 'arraybuffer'
  socket.on('open', events.onOpen)
  socket.on('message', (data: ArrayBuffer) => events.onMessage(data))
  socket.on('close', events.onClose)
  socket.on('error', events.onError)
  return { send: (data) => socket.send(data), close: () => socket.close() }
}

let cached: { key: string; sha256: string } | undefined

/** SHA-256 of the runner bundle, or null when it is not built. */
export async function runnerBundleSha256(): Promise<string | null> {
  let key: string
  try {
    const stat = statSync(env.RUNNER_BUNDLE_PATH)
    key = `${stat.size}:${stat.mtimeMs}`
  } catch {
    return null
  }
  if (cached?.key !== key) {
    const sha256 = createHash('sha256')
      .update(await readFile(env.RUNNER_BUNDLE_PATH))
      .digest('hex')
    cached = { key, sha256 }
  }
  return cached.sha256
}

export async function runnerBundleFile(): Promise<RunnerBundleFile | null> {
  const sha256 = await runnerBundleSha256()
  if (!sha256) return null
  return {
    sha256,
    size: statSync(env.RUNNER_BUNDLE_PATH).size,
    body: Readable.toWeb(createReadStream(env.RUNNER_BUNDLE_PATH)) as ReadableStream,
  }
}

/**
 * The operation call of a workspace's hub when it runs elsewhere (src/hub.ts): never on Node,
 * where every hub is this process's.
 */
export function hubElsewhere(_workspaceId: string): HubCall | null | Promise<HubCall | null> {
  return null
}

/** Whether the workspace's hub is not this process's: never on Node. */
export async function hubIsElsewhere(_workspaceId: string) {
  return false
}

/** Where a workspace's hub runs on Cloudflare: here, the process's, always. */
export async function hubModeOf(_workspaceId: string): Promise<'api' | 'object'> {
  return 'api'
}

/** A workspace's hub mode, as just read: nothing to keep on Node. */
export function noteHubMode(_workspaceId: string, _mode: 'api' | 'object') {}

/** A workspace's hub object: none on Node. */
export function hubStub(_workspaceId: string): HubStub {
  throw new Error('Hubs are Durable Objects only on Cloudflare')
}

/** A new workspace's hub, in an object of its own: on Node, every hub is this process's. */
export async function placeNewHub(_workspaceId: string): Promise<void> {}

/** Move a workspace's hub to an object of its own: only on Cloudflare. */
export async function moveHub(_workspaceId: string, _mode: 'api' | 'object'): Promise<void> {
  throw new Error('Hubs are Durable Objects only on Cloudflare')
}

/**
 * Run a job's message soon (src/jobs.ts): in this process, in the background, as a queue's
 * consumer would; after `delaySeconds` if given.
 */
export async function enqueue(message: import('../jobs.js').JobMessage, delaySeconds = 0) {
  const run = () =>
    void import('../jobs.js').then(({ runJob }) => runJob(message)).catch(() => undefined)
  if (delaySeconds) setTimeout(run, delaySeconds * 1000).unref?.()
  else run()
}

/** Whether jobs go through a queue: never on Node, where timers run them (src/jobs.ts). */
export const jobsOnQueue = () => false

/** The jobs' queue and its dead letters: none on Node. */
export async function jobQueues(): Promise<{
  jobs: import('../ops/checks.js').QueueHealth
  dead: import('../ops/checks.js').QueueHealth
} | null> {
  return null
}
