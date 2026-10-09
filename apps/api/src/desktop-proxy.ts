import { randomBytes } from 'node:crypto'
import { upgradeWebSocket } from '@hono/node-server'
import { Hono } from 'hono'
import WebSocket from 'ws'
import { env } from './config.js'

/**
 * A desktop in the dashboard. The provider's desktop URL logs in with a
 * cookie, which a browser drops for a third-party socket. So the API logs in
 * itself and relays the VNC socket under a short-lived view id; the browser
 * never sees the provider's URL or cookie, only the VNC password it needs.
 */
type View = { origin: string; cookie: string; expiresAt: number }

const views = new Map<string, View>()
const TTL_MS = 60 * 60_000

function live(id: string) {
  const view = views.get(id)
  if (!view || view.expiresAt < Date.now()) {
    views.delete(id)
    return null
  }
  view.expiresAt = Date.now() + TTL_MS
  return view
}

/** Log in to the provider's desktop URL and return a socket on this API for its VNC server. */
export async function openView(providerUrl: string) {
  for (const [id, view] of views) if (view.expiresAt < Date.now()) views.delete(id)
  const login = await fetch(providerUrl, { redirect: 'manual' })
  const cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
  const location = login.headers.get('location')
  if (login.status < 300 || login.status >= 400 || !location)
    throw new Error(`desktop login answered ${login.status}`)
  const target = new URL(location, providerUrl)

  const id = randomBytes(24).toString('base64url')
  views.set(id, { origin: target.origin, cookie, expiresAt: Date.now() + TTL_MS })
  return {
    socketUrl: `${env.API_URL.replace(/^http/, 'ws')}/desktop/${id}/websockify`,
    password: target.searchParams.get('password') ?? '',
  }
}

export const desktopProxy = new Hono().get(
  '/:id/websockify',
  upgradeWebSocket((c) => {
    const view = live(c.req.param('id') ?? '')
    if (!view) return { onOpen: (_e, ws) => ws.close(4404, 'view expired') }
    let upstream: WebSocket | undefined
    const pending: ArrayBuffer[] = []
    return {
      onOpen: (_e, ws) => {
        upstream = new WebSocket(`${view.origin.replace(/^http/, 'ws')}/websockify`, 'binary', {
          headers: { cookie: view.cookie, origin: view.origin },
        })
        upstream.binaryType = 'arraybuffer'
        upstream.on('open', () => {
          for (const data of pending.splice(0)) upstream!.send(data)
        })
        upstream.on('message', (data: ArrayBuffer) => ws.send(new Uint8Array(data)))
        upstream.on('close', () => ws.close())
        upstream.on('error', () => ws.close(1011, 'desktop unavailable'))
      },
      onMessage: (e) => {
        if (typeof e.data === 'string') return
        const data = e.data as ArrayBuffer
        if (upstream?.readyState === WebSocket.OPEN) upstream.send(data)
        else pending.push(data)
      },
      onClose: () => upstream?.close(),
    }
  }),
)
