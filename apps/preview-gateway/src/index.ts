// The previews' own site: https://<id>.brigade.surf in front of each preview's address at
// the provider (Boat, https://box-….on.boat.dev).
//
// The provider lets a request in with its token: once in the address's query (?_token=),
// which it trades for a cookie (_port_auth, SameSite=None, not partitioned). The dashboard
// shows the preview in a frame on another site, where Safari, and so every browser on an
// iPhone, drops that cookie: the page came, its scripts and styles got 403, the frame stayed
// white. Here the token goes on each request from this Worker, so the browser keeps no
// cookie of the provider's.
//
// - POST https://brigade.surf/routes (the API, with the shared secret) registers a thread's
//   preview: the provider's address with its token, and the thread. Its address here is
//   keyed by both, so two threads previewing the same repository on one computer (the same
//   port, the same address at the provider) never share one. A thread has one route and an
//   address at the provider one thread: registering drops the others, so a preview's address
//   here never reaches the next thread's app on that port. A new route gets a new nonce,
//   which ends the cookies and grants of the run before.
// - DELETE https://brigade.surf/routes drops a thread's route: its preview stopped, or the
//   thread was deleted.
// - The id in the address does not let anyone in by itself: the API hands whoever may see
//   the thread an access token for a few minutes, which this site trades for a cookie of
//   its own, or a grant in the host where the browser drops that cookie (src/access.ts).
//   Anything else gets a page that says to open the preview from Brigade.
// - Any request let in goes to that address with the token, redirects to it come back
//   here, and WebSockets (hot reload) pass through.
// - The runner's proxy gives the app this host as the Host it was asked for (preview-proxy.ts).
// - Browsers ask again for each file before using what they kept (cacheControl).
import {
  ACCESS_COOKIE,
  ACCESS_PARAM,
  ACCESS_SECONDS,
  TRIED_PARAM,
  accessCookie,
  cookieOf,
  grantLabel,
  mac,
  same,
  validAccess,
  validCookie,
  validGrant,
} from './access'

export type Env = {
  DB: D1Database
  /** brigade.surf: the registrations at the apex, previews one level under it. */
  DOMAIN: string
  /** The end of the provider's hosts: the only addresses it forwards to. */
  UPSTREAM_SUFFIX: string
  /** Shared with the API (PREVIEW_GATEWAY_SECRET): registers previews, keys their ids and access. */
  SECRET: string
}

type Route = { thread: string; origin: string; token: string; nonce: string }

/** The provider's names: the token in the address it gives, and the cookie it trades it for. */
const TOKEN_PARAM = '_token'
const TOKEN_COOKIE = '_port_auth'

/** A host here: the id (26 base32 characters, 130 bits), then a grant for Safari's frame. */
const HOST = /^([a-z2-7]{26})(?:-([a-z2-7]{36}))?$/

/** A thread's id, as the API gives it. */
const THREAD = /^[A-Za-z0-9_-]{1,64}$/

/**
 * The id of a thread's preview at a provider's address: keyed with the secret, so it cannot
 * be guessed from them, and with the thread, so another thread's preview there has another.
 */
export async function routeId(secret: string, thread: string, origin: string) {
  return (await mac(secret, 'route', thread, origin)).slice(0, 26)
}

/** The request's cookies with the provider's token, whatever the browser sent for it, and without this site's own. */
export function withToken(cookie: string | null, token: string) {
  const kept = (cookie ?? '')
    .split(';')
    .map((c) => c.trim())
    .filter((c) => c && !c.startsWith(`${TOKEN_COOKIE}=`) && !c.startsWith(`${ACCESS_COOKIE}=`))
  return [...kept, `${TOKEN_COOKIE}=${token}`].join('; ')
}

/**
 * A cookie the app sets, for this host only. brigade.surf is not on the Public Suffix List,
 * so a cookie with Domain=brigade.surf would go to every other preview, and to its app. Not
 * the provider's token cookie, nor this site's own: null.
 */
export function hostOnly(setCookie: string) {
  const [pair = '', ...attributes] = setCookie.split(';')
  const name = pair.split('=')[0]!.trim()
  if (name === TOKEN_COOKIE || name === ACCESS_COOKIE) return null
  return [
    pair,
    ...attributes.filter((a) => a.split('=')[0]!.trim().toLowerCase() !== 'domain'),
  ].join(';')
}

// A route is read from the database for each request, never kept: a route dropped or taken
// over in another isolate (a preview stopped, another thread took its address) must stop
// working at once, or the old thread's cookie would reach the new thread's app. Requests
// asking at the same time (a page's burst) share one read.
const reading = new Map<string, Promise<Route | null>>()

function route(env: Env, id: string): Promise<Route | null> {
  const pending = reading.get(id)
  if (pending) return pending
  const read = env.DB.prepare('SELECT thread, origin, token, nonce FROM previews WHERE id = ?')
    .bind(id)
    .first<Route>()
    .finally(() => reading.delete(id))
  reading.set(id, read)
  return read
}

const authorized = (request: Request, env: Env) =>
  same(request.headers.get('authorization') ?? '', `Bearer ${env.SECRET}`)

async function register(request: Request, env: Env) {
  if (!authorized(request, env)) return new Response('Unauthorized', { status: 401 })
  const body = (await request.json().catch(() => null)) as {
    url?: unknown
    thread?: unknown
  } | null
  let url: URL
  try {
    url = new URL(String(body?.url))
  } catch {
    return new Response('Expected {"url": the address with its token, "thread"}', { status: 400 })
  }
  const token = url.searchParams.get(TOKEN_PARAM)
  if (url.protocol !== 'https:' || !url.hostname.endsWith(env.UPSTREAM_SUFFIX) || !token)
    return new Response(`Not a preview address at *${env.UPSTREAM_SUFFIX}`, { status: 400 })
  // An API from before threads had routes of their own: it then hands out the provider's address.
  const thread = typeof body?.thread === 'string' ? body.thread : ''
  if (!THREAD.test(thread)) return new Response('Expected the thread', { status: 400 })
  const id = await routeId(env.SECRET, thread, url.origin)
  const [, saved] = await env.DB.batch<{ nonce: string }>([
    // One route per thread, one thread per address at the provider.
    env.DB.prepare('DELETE FROM previews WHERE (thread = ?1 OR origin = ?2) AND id != ?3').bind(
      thread,
      url.origin,
      id,
    ),
    // The same preview registered again (another person opens it) keeps its nonce.
    env.DB.prepare(
      `INSERT INTO previews (id, thread, origin, token, nonce, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (id) DO UPDATE SET token = excluded.token, updated_at = excluded.updated_at
       RETURNING nonce`,
    ).bind(id, thread, url.origin, token, crypto.randomUUID(), Date.now()),
  ])
  const nonce = saved?.results[0]?.nonce
  if (!nonce) return new Response('The route was not saved', { status: 503 })
  return Response.json({ origin: `https://${id}.${env.DOMAIN}` })
}

async function revoke(request: Request, env: Env) {
  if (!authorized(request, env)) return new Response('Unauthorized', { status: 401 })
  const body = (await request.json().catch(() => null)) as { thread?: unknown } | null
  const thread = typeof body?.thread === 'string' ? body.thread : ''
  if (!THREAD.test(thread)) return new Response('Expected {"thread"}', { status: 400 })
  await env.DB.prepare('DELETE FROM previews WHERE thread = ?').bind(thread).run()
  return new Response(null, { status: 204 })
}

/** Where a request goes at the provider: its path and query on the route's origin, never another host. */
export function upstreamUrl(request: URL, origin: string) {
  // Not new URL(path, origin): a path like //attacker.example/x would be another host.
  const url = new URL(origin)
  url.pathname = request.pathname
  url.search = withoutAccess(request.search)
  return url
}

/** A query without this site's own parameters; the rest as it came, byte for byte. */
export function withoutAccess(search: string) {
  const kept = search
    .replace(/^\?/, '')
    .split('&')
    .filter((part) => {
      const name = part.split('=')[0]!
      return part && name !== ACCESS_PARAM && name !== TRIED_PARAM
    })
  return kept.length ? `?${kept.join('&')}` : ''
}

/**
 * How long a browser may keep an answer: ask each time. Cloudflare's Browser Cache TTL turns
 * an app's no-cache into four hours (max-age=14400) on scripts and styles, and a dev server
 * (Next's Turbopack) keeps a chunk's name when an edit changes it: after a reload the page
 * ran the old code. Chrome keeps a frame's cache apart from a tab's, so the dashboard's
 * pane stayed on it while a new tab showed the edit. Asking again costs a 304 each.
 */
export function cacheControl(upstream: string | null) {
  return upstream && /\bno-store\b/i.test(upstream) ? upstream : 'private, no-cache'
}

/**
 * How the browser sees the preview: its address here (base), and a grant's when it came
 * through one (grant): at that host (Safari's frame), or from a page there (cors).
 */
type View = { base: string; grant?: string; cors?: boolean }

async function forward(request: Request, target: Route, view: View) {
  const url = new URL(request.url)
  const headers = new Headers(request.headers)
  // Its own: the provider's, from the address.
  headers.delete('host')
  headers.set('cookie', withToken(request.headers.get('cookie'), target.token))
  // The provider refuses a WebSocket (a dev server's hot reload) from any page but its own
  // address's. It is this address's here: the same check, then its own origin for the provider.
  // The runner's proxy gives the app this one back (preview-proxy.ts).
  const origin = request.headers.get('origin')
  const websocket = request.headers.get('upgrade')?.toLowerCase() === 'websocket'
  if (origin && websocket) {
    if (origin !== url.origin && origin !== view.grant)
      return new Response('cross-origin websocket denied', { status: 403 })
    headers.set('origin', target.origin)
  } else if (view.grant) {
    // The app knows the preview by its address here, not a grant's: its checks of the
    // Origin and Referer (CSRF, Next's server actions) see that one.
    if (origin === view.grant) headers.set('origin', view.base)
    const referer = request.headers.get('referer')
    if (referer?.startsWith(`${view.grant}/`))
      headers.set('referer', view.base + referer.slice(view.grant.length))
  }
  let response: Response
  try {
    response = await fetch(upstreamUrl(url, target.origin), {
      method: request.method,
      headers,
      body: request.body,
      redirect: 'manual',
    })
  } catch (error) {
    console.error(`${request.method} ${url.pathname} at the provider: ${String(error)}`)
    return new Response('The preview does not answer', { status: 502 })
  }
  // A WebSocket's answer goes back as it is.
  if (response.webSocket) return response
  const answer = new Response(response.body, response)
  // The host is what lets people in at a grant: no other site gets it as the Referer of a
  // link, an image or a font. (A cross-origin fetch with CORS still sends it as its Origin.)
  answer.headers.set('referrer-policy', 'same-origin')
  answer.headers.set('cache-control', cacheControl(response.headers.get('cache-control')))
  // A redirect to the provider's address stays here, where the browser needs no cookie; at
  // a grant, one to the address here stays at the grant.
  const location = response.headers.get('location')
  if (location) {
    const to = URL.canParse(location) ? new URL(location) : null
    if (to?.origin === target.origin || (view.grant && to?.origin === view.base))
      answer.headers.set('location', `${url.origin}${to!.pathname}${to!.search}${to!.hash}`)
  }
  answer.headers.delete('set-cookie')
  for (const cookie of response.headers.getSetCookie()) {
    const kept = hostOnly(cookie)
    if (kept) answer.headers.append('set-cookie', kept)
  }
  if (view.cors && view.grant) {
    // The page at a grant is the same app: what it asks of the address here is its own.
    answer.headers.set('access-control-allow-origin', view.grant)
    answer.headers.set('access-control-allow-credentials', 'true')
    answer.headers.append('vary', 'Origin')
  }
  return answer
}

function redirect(to: URL | string, cookie?: string) {
  const headers = new Headers({ location: String(to), 'cache-control': 'no-store' })
  if (cookie) headers.set('set-cookie', cookie)
  return new Response(null, { status: 302, headers })
}

/** The address without this site's own parameters. */
function clean(url: URL) {
  const to = new URL(url)
  to.search = withoutAccess(url.search)
  return to
}

/** A person who did not come from Brigade: a page that says where to open it. */
export function denied(request: Request, expired = false) {
  const why = expired
    ? 'This link to the preview has expired.'
    : 'This preview opens only for people who open it from Brigade.'
  const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }
  const mode = request.headers.get('sec-fetch-mode')
  const page = mode ? mode === 'navigate' : !!request.headers.get('accept')?.includes('text/html')
  if (!page)
    return new Response(why, {
      status: 403,
      headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' },
    })
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Open this preview from Brigade</title>` +
      `<body style="font:15px/1.5 system-ui,sans-serif;color:#1f1f1f;max-width:32rem;margin:15vh auto;padding:0 1.5rem">` +
      `<h1 style="font-size:1.25rem">Open this preview from Brigade</h1>` +
      `<p>${why} Open it again from its thread in Brigade: in the preview panel, or with Open in a new tab there.</p>`,
    { status: 403, headers: { ...headers, 'content-type': 'text/html; charset=utf-8' } },
  )
}

/** A grant's origin of this preview, valid now, or null. */
async function grantOrigin(env: Env, id: string, route: Route, origin: string | null) {
  const host = URL.canParse(origin ?? '') ? new URL(origin!) : null
  if (host?.protocol !== 'https:' || !host.hostname.endsWith(`.${env.DOMAIN}`)) return null
  const match = HOST.exec(host.hostname.slice(0, -env.DOMAIN.length - 1))
  if (match?.[1] !== id || !match[2]) return null
  return (await validGrant(env.SECRET, id, route.nonce, match[2])) ? host.origin : null
}

async function enter(
  request: Request,
  env: Env,
  id: string,
  grant: string | undefined,
  target: Route,
) {
  const url = new URL(request.url)
  const base = `https://${id}.${env.DOMAIN}`
  if (grant) {
    if (!(await validGrant(env.SECRET, id, target.nonce, grant))) return denied(request, true)
    if (url.searchParams.has(ACCESS_PARAM) || url.searchParams.has(TRIED_PARAM))
      return redirect(clean(url))
    return forward(request, target, { base, grant: url.origin })
  }
  const signedIn = await validCookie(
    env.SECRET,
    id,
    target.nonce,
    cookieOf(request.headers.get('cookie')),
  )
  const access = url.searchParams.get(ACCESS_PARAM)
  if (access !== null && (request.method === 'GET' || request.method === 'HEAD')) {
    if (signedIn) return redirect(clean(url))
    if (!(await validAccess(env.SECRET, id, access))) return denied(request, true)
    if (url.searchParams.has(TRIED_PARAM)) {
      // The cookie set one step before did not come back: this browser drops it here.
      const to = clean(url)
      to.hostname = `${await grantLabel(env.SECRET, id, target.nonce)}.${env.DOMAIN}`
      return redirect(to)
    }
    const tried = new URL(url)
    tried.searchParams.set(TRIED_PARAM, '1')
    const value = await accessCookie(env.SECRET, id, target.nonce)
    return redirect(
      tried,
      `${ACCESS_COOKIE}=${value}; Path=/; Max-Age=${ACCESS_SECONDS}; Secure; HttpOnly; SameSite=None; Partitioned`,
    )
  }
  if (signedIn || (access !== null && (await validAccess(env.SECRET, id, access))))
    return forward(request, target, { base })
  // A page at a grant of this preview asking for an address here (the app's own, from
  // BRIGADE_PREVIEW_URL, in Safari's frame): it sends the grant as its Origin.
  const from = await grantOrigin(env, id, target, request.headers.get('origin'))
  if (from) {
    if (request.method === 'OPTIONS' && request.headers.has('access-control-request-method'))
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': from,
          'access-control-allow-credentials': 'true',
          'access-control-allow-methods': request.headers.get('access-control-request-method')!,
          'access-control-allow-headers':
            request.headers.get('access-control-request-headers') ?? '',
          'access-control-max-age': '600',
          vary: 'Origin',
        },
      })
    return forward(request, target, { base, grant: from, cors: true })
  }
  return denied(request)
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.hostname === env.DOMAIN) {
      if (url.pathname === '/routes' && request.method === 'POST') return register(request, env)
      if (url.pathname === '/routes' && request.method === 'DELETE') return revoke(request, env)
      return new Response('Not found', { status: 404 })
    }
    const label = url.hostname.endsWith(`.${env.DOMAIN}`)
      ? url.hostname.slice(0, -env.DOMAIN.length - 1)
      : ''
    const match = HOST.exec(label)
    let target: Route | null
    try {
      target = match ? await route(env, match[1]!) : null
    } catch (error) {
      console.error(`reading the route of ${label}: ${String(error)}`)
      return new Response('The preview gateway could not read its routes', { status: 503 })
    }
    if (!target)
      return new Response('This preview is not running, or its address changed.', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      })
    return enter(request, env, match![1]!, match![2], target)
  },
} satisfies ExportedHandler<Env>
