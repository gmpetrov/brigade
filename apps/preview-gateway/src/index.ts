// The previews' own site: https://<id>.brigade.surf in front of each preview's address at
// the provider (Boat, https://box-….on.boat.dev).
//
// The provider lets a request in with its token: once in the address's query (?_token=),
// which it trades for a cookie (_port_auth, SameSite=None, not partitioned). The dashboard
// shows the preview in a frame on another site, where Safari, and so every browser on an
// iPhone, drops that cookie: the page came, its scripts and styles got 403, the frame stayed
// white. Here the token goes on each request from this Worker, so the browser keeps no
// cookie of the provider's, and the id in the address is what lets a person in.
//
// - POST https://brigade.surf/routes (the API, with the shared secret) registers a
//   preview's address with its token and answers its address here. The same address at
//   the provider gets the same one here each time.
// - Any request to <id>.brigade.surf goes to that address with the token, redirects
//   to it come back here, and WebSockets (hot reload) pass through.
// - The runner's proxy gives the app this host as the Host it was asked for (preview-proxy.ts).

export type Env = {
  DB: D1Database
  /** brigade.surf: the registrations at the apex, previews one level under it. */
  DOMAIN: string
  /** The end of the provider's hosts: the only addresses it forwards to. */
  UPSTREAM_SUFFIX: string
  /** Shared with the API (PREVIEW_GATEWAY_SECRET): registers previews, and keys their ids. */
  SECRET: string
}

type Route = { origin: string; token: string }

/** The provider's names: the token in the address it gives, and the cookie it trades it for. */
export const TOKEN_PARAM = '_token'
export const TOKEN_COOKIE = '_port_auth'

/** An id: 26 base32 characters (130 bits), a DNS label. */
const ID = /^[a-z2-7]{26}$/

/** The id of a provider's address here: keyed with the secret, so it cannot be guessed from it. */
export async function routeId(secret: string, origin: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(origin)),
  )
  return base32(mac).slice(0, 26)
}

function base32(bytes: Uint8Array) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  let out = ''
  let bits = 0
  let value = 0
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  return out
}

/** The request's cookies with the provider's token, whatever the browser sent for it. */
export function withToken(cookie: string | null, token: string) {
  const kept = (cookie ?? '')
    .split(';')
    .map((c) => c.trim())
    .filter((c) => c && !c.startsWith(`${TOKEN_COOKIE}=`))
  return [...kept, `${TOKEN_COOKIE}=${token}`].join('; ')
}

/** Equal strings in a time that does not tell how much of them matched. */
function same(a: string, b: string) {
  const x = new TextEncoder().encode(a)
  const y = new TextEncoder().encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

// Routes this isolate has read: a page's requests (hundreds for a dev server) read the
// database once. A route only changes its token, and the provider's stay the same.
const cache = new Map<string, { route: Route; at: number }>()
const CACHE_MS = 5 * 60_000

async function route(env: Env, id: string): Promise<Route | null> {
  const hit = cache.get(id)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.route
  const row = await env.DB.prepare('SELECT origin, token FROM routes WHERE id = ?')
    .bind(id)
    .first<Route>()
  if (row) cache.set(id, { route: row, at: Date.now() })
  return row
}

async function register(request: Request, env: Env) {
  if (!same(request.headers.get('authorization') ?? '', `Bearer ${env.SECRET}`))
    return new Response('Unauthorized', { status: 401 })
  const body = (await request.json().catch(() => null)) as { url?: unknown } | null
  let url: URL
  try {
    url = new URL(String(body?.url))
  } catch {
    return new Response('Expected {"url": the address with its token}', { status: 400 })
  }
  const token = url.searchParams.get(TOKEN_PARAM)
  if (url.protocol !== 'https:' || !url.hostname.endsWith(env.UPSTREAM_SUFFIX) || !token)
    return new Response(`Not a preview address at *${env.UPSTREAM_SUFFIX}`, { status: 400 })
  const id = await routeId(env.SECRET, url.origin)
  await env.DB.prepare(
    `INSERT INTO routes (id, origin, token, updated_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (id) DO UPDATE SET token = excluded.token, updated_at = excluded.updated_at`,
  )
    .bind(id, url.origin, token, Date.now())
    .run()
  cache.set(id, { route: { origin: url.origin, token }, at: Date.now() })
  return Response.json({ origin: `https://${id}.${env.DOMAIN}` })
}

/** Where a request goes at the provider: its path and query on the route's origin, never another host. */
export function upstreamUrl(request: URL, origin: string) {
  // Not new URL(path, origin): a path like //attacker.example/x would be another host.
  const url = new URL(origin)
  url.pathname = request.pathname
  url.search = request.search
  return url
}

async function forward(request: Request, target: Route) {
  const url = new URL(request.url)
  const headers = new Headers(request.headers)
  // Its own: the provider's, from the address.
  headers.delete('host')
  headers.set('cookie', withToken(request.headers.get('cookie'), target.token))
  let response: Response
  try {
    response = await fetch(upstreamUrl(url, target.origin), {
      method: request.method,
      headers,
      body: request.body,
      redirect: 'manual',
    })
  } catch {
    return new Response('The preview does not answer', { status: 502 })
  }
  // A WebSocket's answer goes back as it is.
  if (response.webSocket) return response
  const answer = new Response(response.body, response)
  // The host is what lets people in: no other site gets it as the Referer of a link, an
  // image or a font. (A cross-origin fetch with CORS still sends it as its Origin.)
  answer.headers.set('referrer-policy', 'same-origin')
  // A redirect to the provider's address stays here, where the browser needs no cookie.
  const location = response.headers.get('location')
  if (location) {
    const to = URL.canParse(location) ? new URL(location) : null
    if (to?.origin === target.origin)
      answer.headers.set('location', `${url.origin}${to.pathname}${to.search}${to.hash}`)
  }
  return answer
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.hostname === env.DOMAIN) {
      if (url.pathname === '/routes' && request.method === 'POST') return register(request, env)
      return new Response('Not found', { status: 404 })
    }
    const id = url.hostname.endsWith(`.${env.DOMAIN}`)
      ? url.hostname.slice(0, -env.DOMAIN.length - 1)
      : ''
    const target = ID.test(id) ? await route(env, id) : null
    if (!target)
      return new Response('This preview is not running, or its address changed.', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      })
    return forward(request, target)
  },
} satisfies ExportedHandler<Env>
