// The API's platform on Node.js (see ./types.ts).
import { createHash } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import WebSocket from 'ws'
import { env } from '../config.js'
import type { RunnerBundleFile, Upstream, UpstreamEvents } from './types.js'

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
