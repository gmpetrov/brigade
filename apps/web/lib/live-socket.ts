'use client'
import { KEEPALIVE } from '@brigade/contracts'
import { WS_URL } from './config'

// The dashboard's live sockets go to the hub of the workspace it shows (docs/workspace-hubs-plan.md
// in the repository): named once the dashboard knows it. Before then, the API finds it from the
// session.
let workspaceId: string | undefined

/** The workspace the dashboard shows: its sockets name it from now on. */
export function setLiveWorkspace(id: string | null | undefined) {
  workspaceId = id ?? undefined
}

/**
 * Up to this much more is waited before a dropped socket connects again, at random: a deploy of
 * the API drops every dashboard's sockets at once, and without it they would all come back, and
 * fetch their lists again, in the same second.
 */
export const RECONNECT_SPREAD_MS = 4_000

/** How long a dropped socket waits before connecting again, after `base`: spread over a few seconds. */
export const reconnectDelay = (base: number, random: () => number = Math.random) =>
  Math.round(base + random() * RECONNECT_SPREAD_MS)

/** A live socket to the API, for the dashboard's workspace. */
export function liveSocket() {
  const query = workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : ''
  return new WebSocket(`${WS_URL}/api/ws${query}`)
}

/**
 * Say the socket is still there every half minute, so it never looks idle (Cloudflare closes one
 * silent for a minute): exactly as KEEPALIVE, which the workspace's hub answers without waking.
 * Returns what stops it.
 */
export function keepAlive(socket: WebSocket) {
  const timer = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) socket.send(KEEPALIVE)
  }, 30_000)
  return () => clearInterval(timer)
}
