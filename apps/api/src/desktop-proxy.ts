import { randomBytes } from 'node:crypto'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { desktopUrl } from './cloud.js'
import { env } from './config.js'
import { connectSocket, upgradeWebSocket } from './platform/node.js'
import type { Upstream } from './platform/types.js'

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

/**
 * The workspace computer's desktop to watch, relayed through this API: a thread's,
 * or a teammate's (the same screen; each teammate has its own browser on it).
 * 409 while it is not up.
 */
export async function watchDesktop(computer: { status: string; providerRef: unknown }) {
  if (computer.status !== 'running')
    throw new HTTPException(409, {
      message: 'The cloud computer is not running. It starts with the next message.',
    })
  const url = await desktopUrl(computer)
  if (!url)
    throw new HTTPException(409, {
      message: 'The desktop is not available yet. Try again in a moment.',
    })
  return openView(url).catch((error: unknown) => {
    throw new HTTPException(503, {
      message: `The desktop did not answer: ${(error as Error).message}`,
    })
  })
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
    let upstream: Upstream | undefined
    let open = false
    const pending: ArrayBuffer[] = []
    return {
      onOpen: (_e, ws) => {
        upstream = connectSocket(
          `${view.origin}/websockify`,
          { protocol: 'binary', headers: { cookie: view.cookie, origin: view.origin } },
          {
            onOpen: () => {
              open = true
              for (const data of pending.splice(0)) upstream!.send(data)
            },
            onMessage: (data) => ws.send(new Uint8Array(data)),
            onClose: () => ws.close(),
            onError: () => ws.close(1011, 'desktop unavailable'),
          },
        )
      },
      onMessage: (e) => {
        if (typeof e.data === 'string') return
        const data = e.data as ArrayBuffer
        if (open) upstream!.send(data)
        else pending.push(data)
      },
      onClose: () => upstream?.close(),
    }
  }),
)
