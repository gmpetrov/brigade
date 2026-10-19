// The preview's one address: /api (requests and WebSockets) to the API, the
// rest to Next. One origin means one preview token, and the dashboard's
// session cookie is first-party to its API.
import http from 'node:http'
import net from 'node:net'

const PORT = Number(process.env.PORT ?? 3000)
const API_PORT = Number(process.env.API_PORT ?? 3001)
const WEB_PORT = Number(process.env.WEB_PORT ?? 3002)

const target = (url = '/') => (url === '/api' || url.startsWith('/api/') ? API_PORT : WEB_PORT)

// A page opened without a working session is opened signed in as SIGN_IN (a dev
// account), so a preview shows the sample workspace at once, also after its session
// expired or the database was reset. Signing out sets a marker cookie for the rest of
// the browser session, so the sign-in page then stays to try another account. Empty: off.
const SIGN_IN = process.env.PREVIEW_SIGN_IN ?? ''
const PASSWORD = process.env.PREVIEW_SIGN_IN_PASSWORD ?? 'correct-horse-battery'
const ORIGIN = process.env.PREVIEW_URL ?? `http://localhost:${PORT}`
const MARKER = 'brigade_preview_signed_out'
const SESSION = /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=/
const MARKER_SET = new RegExp(`(?:^|;\\s*)${MARKER}=`)

const isSignOut = (req) => req.method === 'POST' && (req.url ?? '').split('?')[0] === '/api/auth/sign-out'

/** A page load to sign in for: no session the API still accepts, and no sign-out. */
const needsSignIn = async (req) =>
  Boolean(SIGN_IN) &&
  req.method === 'GET' &&
  target(req.url) === WEB_PORT &&
  !req.url.startsWith('/_next/') &&
  (req.headers.accept ?? '').includes('text/html') &&
  !MARKER_SET.test(req.headers.cookie ?? '') &&
  !(await hasSession(req.headers.cookie ?? ''))

/** Whether the API accepts the browser's session cookie (expired or reset: it does not). */
function hasSession(cookie) {
  if (!SESSION.test(cookie)) return Promise.resolve(false)
  return new Promise((resolve) => {
    const request = http.get(
      { host: '127.0.0.1', port: API_PORT, path: '/api/auth/get-session', headers: { cookie, origin: ORIGIN } },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => (body += chunk))
        response.on('end', () => resolve(response.statusCode === 200 && body.trim() !== 'null'))
      },
    )
    // The API not up yet: leave the cookie be rather than replace a session that may work.
    request.on('error', () => resolve(true))
  })
}

const markerCookie = () =>
  `${MARKER}=1; Path=/; HttpOnly` +
  (ORIGIN.startsWith('https://') ? '; Secure; SameSite=None; Partitioned' : '; SameSite=Lax')

/**
 * Sign in through the API as a browser would: its session cookies, or null when it refuses.
 * Next is often up before the API, so this waits for the API to answer.
 */
async function signIn() {
  for (const deadline = Date.now() + 30_000; ;) {
    const result = await trySignIn()
    if (result !== 'unreachable') return result
    if (Date.now() > deadline) return null
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

function trySignIn() {
  return new Promise((resolve) => {
    const body = JSON.stringify({ email: SIGN_IN, password: PASSWORD })
    const request = http.request(
      {
        host: '127.0.0.1',
        port: API_PORT,
        path: '/api/auth/sign-in/email',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          origin: ORIGIN,
        },
      },
      (response) => {
        response.resume()
        const cookies = response.headers['set-cookie'] ?? []
        resolve(response.statusCode === 200 && cookies.length ? cookies : null)
      },
    )
    request.on('error', () => resolve('unreachable'))
    request.end(body)
  })
}

/** The sign-in's ?next= when it is on this preview, else the dashboard. */
function afterSignIn(url = '/') {
  const next = new URL(url, ORIGIN).searchParams.get('next')
  if (!next) return '/app'
  try {
    const to = new URL(next, ORIGIN)
    if (to.origin === new URL(ORIGIN).origin) return to.pathname + to.search
  } catch {}
  return '/app'
}

// Shown while Next starts or restarts, instead of a blank page.
const WAITING =
  '<!doctype html><meta http-equiv="refresh" content="3"><title>Starting…</title>' +
  '<p style="font-family:system-ui,sans-serif;padding:2rem">Brigade is starting. This page reloads by itself.</p>'

const server = http.createServer(async (req, res) => {
  // Signed in for this request already, and for the next ones once the browser keeps the cookies.
  const first = await needsSignIn(req)
  const signedIn = first ? await signIn() : null
  if (first && !signedIn) console.warn(`Could not sign in as ${SIGN_IN}: the page opens signed out`)
  // From the landing or sign-in page, straight to the dashboard, or to the sign-in's ?next=
  // on this preview (an App's sign-in coming back). Its own request is passed through,
  // signed in, so a browser that drops the cookies cannot loop here.
  const path = (req.url ?? '/').split('?')[0]
  if (signedIn && (path === '/' || path === '/sign-in')) {
    res.writeHead(302, {
      location: afterSignIn(req.url),
      'set-cookie': signedIn,
      'cache-control': 'no-store',
    })
    return res.end()
  }
  // The preview pane has no address bar and opens the landing page: a preview is for the
  // dashboard, which sends a signed-out browser on to the sign-in page. PREVIEW_LANDING=1
  // keeps the landing, to work on it (with PREVIEW_SIGN_IN= so it opens signed out).
  if (req.method === 'GET' && path === '/' && !process.env.PREVIEW_LANDING) {
    res.writeHead(302, { location: '/app', 'cache-control': 'no-store' })
    return res.end()
  }
  const headers = { ...req.headers }
  if (signedIn) {
    const pairs = signedIn.map((c) => c.split(';')[0])
    headers.cookie = [headers.cookie, ...pairs].filter(Boolean).join('; ')
  }
  const upstream = http.request(
    {
      host: '127.0.0.1',
      port: target(req.url),
      path: req.url,
      method: req.method,
      headers,
    },
    (response) => {
      const raw = [...response.rawHeaders]
      if (signedIn) {
        for (const cookie of signedIn) raw.push('Set-Cookie', cookie)
        raw.push('Cache-Control', 'no-store')
      }
      if (isSignOut(req)) raw.push('Set-Cookie', markerCookie())
      res.writeHead(response.statusCode ?? 502, raw)
      response.pipe(res)
    },
  )
  upstream.on('error', () => {
    if (res.headersSent) return res.destroy()
    res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' }).end(WAITING)
  })
  req.pipe(upstream)
})

server.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(target(req.url), '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`]
    for (let i = 0; i < req.rawHeaders.length; i += 2)
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
    upstream.write(head)
    upstream.pipe(socket).pipe(upstream)
  })
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
})

server.listen(PORT, '0.0.0.0', () =>
  console.log(`Preview on port ${PORT}: /api to port ${API_PORT}, the rest to port ${WEB_PORT}`),
)
