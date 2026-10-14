// The API's platform on Cloudflare Workers (see ./types.ts). An alias in
// wrangler.jsonc puts this module in place of ./node.ts.
import { env } from 'cloudflare:workers'
import { defineWebSocketHelper, WSContext } from 'hono/ws'
import type { RunnerBundleFile, Upstream, UpstreamEvents } from './types.js'

type Bindings = {
  ASSETS: { fetch(input: string): Promise<Response> }
  RUNNER_BUNDLE_SHA256?: string
}
const bindings = env as unknown as Bindings

/**
 * Hono's upgradeWebSocket for Workers, which also calls onOpen (Hono's own
 * never does): the hub registers a browser and refuses one there.
 */
export const upgradeWebSocket = defineWebSocketHelper(async (c, events) => {
  if (c.req.header('upgrade') !== 'websocket') return
  const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket]
  server.binaryType = 'arraybuffer'
  const ws = new WSContext({
    close: (code, reason) => {
      try {
        server.close(code, reason)
      } catch {
        // Already closed, or the connection is gone.
      }
    },
    get protocol() {
      return server.protocol
    },
    raw: server,
    get readyState() {
      return server.readyState as 0 | 1 | 2 | 3
    },
    url: null,
    // As the ws package does on Node: a send on a socket that closed is dropped, not
    // thrown (the hub sends to sockets that may have gone).
    send: (source) => {
      if (server.readyState === WebSocket.OPEN) server.send(source)
    },
  })
  server.addEventListener('close', (e) => events.onClose?.(e, ws))
  server.addEventListener('message', (e) => events.onMessage?.(e, ws))
  server.addEventListener('error', (e) => events.onError?.(e, ws))
  server.accept()
  setTimeout(() => events.onOpen?.(new Event('open'), ws), 0)
  // The first subprotocol the client asked for (the desktop's 'binary'), as ws picks on
  // Node: a browser drops a socket whose answer names none of those it asked for.
  const protocol = c.req.header('sec-websocket-protocol')?.split(',')[0]?.trim()
  return new Response(null, {
    status: 101,
    webSocket: client,
    ...(protocol ? { headers: { 'sec-websocket-protocol': protocol } } : {}),
  })
})

export function connectSocket(
  url: string,
  init: { protocol: string; headers: Record<string, string> },
  events: UpstreamEvents,
): Upstream {
  let socket: WebSocket | undefined
  let closed = false
  void fetch(url.replace(/^ws/, 'http'), {
    headers: { ...init.headers, upgrade: 'websocket', 'sec-websocket-protocol': init.protocol },
  }).then(
    (response) => {
      const ws = response.webSocket
      if (!ws) return events.onError()
      ws.accept()
      ws.binaryType = 'arraybuffer'
      if (closed) return ws.close()
      socket = ws
      ws.addEventListener('message', (e) => {
        if (typeof e.data !== 'string') events.onMessage(e.data as ArrayBuffer)
      })
      ws.addEventListener('close', () => events.onClose())
      ws.addEventListener('error', () => events.onError())
      events.onOpen()
    },
    () => events.onError(),
  )
  return {
    send: (data) => socket?.send(data),
    close: () => {
      closed = true
      socket?.close()
    },
  }
}

/** Set at deploy, from the bundle put in the Worker's static assets. */
export async function runnerBundleSha256(): Promise<string | null> {
  return bindings.RUNNER_BUNDLE_SHA256 || null
}

export async function runnerBundleFile(): Promise<RunnerBundleFile | null> {
  const sha256 = await runnerBundleSha256()
  if (!sha256) return null
  const response = await bindings.ASSETS.fetch('https://assets.local/runner/brigade-runner.tgz')
  if (!response.ok || !response.body) return null
  const length = response.headers.get('content-length')
  return { sha256, size: length ? Number(length) : null, body: response.body }
}
