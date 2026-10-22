// The proxy in front of a preview: what a person's browser reaches, at one
// address, whatever the app is doing.
//
// - The app's other ports (its API) are served under /__ports/<port>/ on the
//   same address: one origin, one token from the provider, no CORS.
// - The dashboard shows the preview in a frame on another site, where a
//   browser drops SameSite=Lax cookies: over HTTPS, the app's cookies become
//   SameSite=None; Secure; Partitioned (kept for that frame only) with no
//   Domain, so signing in works in the frame without changing the app.
// - While the app starts, restarts or is down, a page that says so and reloads
//   itself, instead of a blank frame.
// - Its pages get the script that lets people pick elements in them from the
//   dashboard (preview-select.ts).
import http from 'node:http'
import net from 'node:net'
import { pipeline } from 'node:stream'
import {
  SCREENSHOT_SCRIPT_PATH,
  SELECT_SCRIPT,
  SELECT_SCRIPT_PATH,
  screenshotScript,
  withSelectScript,
} from './preview-select.js'

/** Where an app's other ports are served on the preview's address. */
export const PORTS_PREFIX = '/__ports/'

export type ProxyState = 'starting' | 'restarting' | 'running' | 'down'

export type PreviewProxyOptions = {
  /** Where the app listens: the computer's loopback, or its thread's own (its address). */
  host?: string
  /** Where people reach the proxy: all the computer's addresses (default), or its loopback only. */
  bind?: string
  /** The app's port: everything not under PORTS_PREFIX. */
  port: number
  /** Its other ports, served under PORTS_PREFIX. */
  ports: number[]
  /** Rewrite cookies for a cross-site frame: the address people open is HTTPS. */
  crossSiteCookies: boolean
  /** What the app is doing, for the page shown while it does not answer. */
  state: () => ProxyState
  /** Someone used the preview. */
  onUse: () => void
  /** Before a request goes through: a promise while the app is woken (thawed), else nothing. */
  wake?: () => Promise<unknown> | undefined
}

/** A Set-Cookie value a browser keeps in a cross-site frame: Secure, SameSite=None, partitioned, host-only. */
export function crossSiteCookie(cookie: string) {
  const [pair = '', ...attributes] = cookie.split(';')
  const kept = attributes
    .map((a) => a.trim())
    .filter((a) => a && !/^(samesite|domain|secure|partitioned)\s*(=|$)/i.test(a))
  return [pair.trim(), ...kept, 'Secure', 'SameSite=None', 'Partitioned'].join('; ')
}

/** The port a request goes to and the path the app sees; null for an unknown /__ports/ port. */
export function route(url: string, options: Pick<PreviewProxyOptions, 'port' | 'ports'>) {
  if (!url.startsWith(PORTS_PREFIX)) return { port: options.port, path: url, prefix: '' }
  const match = /^\/__ports\/(\d+)(\/.*|\?.*)?$/.exec(url)
  const port = Number(match?.[1])
  if (!match || !options.ports.includes(port)) return null
  const rest = match[2] ?? '/'
  return { port, path: rest.startsWith('?') ? `/${rest}` : rest, prefix: `${PORTS_PREFIX}${port}` }
}

const PAGES: Record<Exclude<ProxyState, 'running'>, [title: string, text: string]> = {
  starting: ['Starting…', 'The app is starting. This page reloads by itself.'],
  restarting: [
    'Restarting…',
    'The app stopped and is starting again. This page reloads by itself.',
  ],
  down: ['Not answering', 'The app does not answer. This page reloads by itself.'],
}

function waitingPage(state: ProxyState) {
  const [title, text] = PAGES[state === 'running' ? 'down' : state]
  return (
    '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="color-scheme" content="light dark">' +
    `<meta http-equiv="refresh" content="2"><title>${title}</title>` +
    '<body style="margin:0;display:grid;place-items:center;min-height:100vh;font:15px system-ui,sans-serif;color:GrayText">' +
    `<p>${text}</p></body></html>`
  )
}

/** Headers about one connection, which the proxy's own connections replace. */
function withoutHopHeaders(headers: http.IncomingHttpHeaders) {
  const { connection: _c, 'keep-alive': _k, ...rest } = headers
  return rest
}

/** A browser loading a page, as opposed to a script fetching data. */
const isNavigation = (req: http.IncomingMessage) =>
  req.headers['sec-fetch-mode'] === 'navigate' ||
  (req.method === 'GET' && (req.headers.accept ?? '').includes('text/html'))

export class PreviewProxy {
  private readonly server: http.Server
  private readonly agent = new http.Agent({ keepAlive: true })
  private readonly sockets = new Set<net.Socket>()
  private lastUse = 0

  constructor(private readonly options: PreviewProxyOptions) {
    // A frozen app is thawed first; the request waits in its socket meanwhile. Its idle
    // connections are dropped: thawed, the app closes them at once (their keep-alive
    // timeouts all passed while it was frozen), under the request sent on one.
    const woken = (go: () => void) => {
      const waking = this.options.wake?.()
      if (!waking) return go()
      void waking.finally(() => {
        for (const free of Object.values(this.agent.freeSockets))
          for (const s of free ?? []) s.destroy()
        go()
      })
    }
    this.server = http.createServer((req, res) => woken(() => this.request(req, res)))
    this.server.on('upgrade', (req, socket, head) =>
      woken(() => this.upgrade(req, socket as net.Socket, head)),
    )
    this.server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.once('close', () => this.sockets.delete(socket))
    })
  }

  /** Listen on the first free port from `from`, skipping `avoid`; resolves to the port. */
  async listen(from: number, avoid: number[]) {
    for (let port = from; port < from + 100 && port <= 65535; port++) {
      if (avoid.includes(port)) continue
      const ok = await new Promise<boolean>((done) => {
        const fail = () => done(false)
        this.server.once('error', fail)
        this.server.listen(port, this.options.bind ?? '0.0.0.0', () => {
          this.server.off('error', fail)
          done(true)
        })
      })
      if (ok) return port
    }
    throw new Error(`No free port for the preview's proxy from ${from}`)
  }

  close() {
    this.server.close()
    for (const socket of this.sockets) socket.destroy()
    this.agent.destroy()
  }

  private used() {
    // Requests come in bursts: once a second is enough.
    const now = Date.now()
    if (now - this.lastUse < 1000) return
    this.lastUse = now
    this.options.onUse()
  }

  private request(req: http.IncomingMessage, res: http.ServerResponse) {
    const path = req.url?.split('?')[0]
    if (path === SELECT_SCRIPT_PATH || path === SCREENSHOT_SCRIPT_PATH)
      return void res
        .writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-cache',
        })
        .end(path === SELECT_SCRIPT_PATH ? SELECT_SCRIPT : screenshotScript())
    this.used()
    const target = route(req.url ?? '/', this.options)
    if (!target)
      return void res.writeHead(404, { 'content-type': 'text/plain' }).end('No such port')
    // A page gets the select script: asked for uncompressed, to add its tag on the way.
    const page = req.method === 'GET' && isNavigation(req)
    const upstream = http.request(
      {
        host: this.options.host ?? '127.0.0.1',
        port: target.port,
        path: target.path,
        method: req.method,
        headers: {
          ...withoutHopHeaders(req.headers),
          ...(target.prefix && { 'x-forwarded-prefix': target.prefix }),
          ...(page && { 'accept-encoding': 'identity' }),
        },
        agent: this.agent,
      },
      (response) => {
        const headers = withoutHopHeaders(response.headers)
        const tagged =
          page &&
          /^text\/html/i.test(headers['content-type'] ?? '') &&
          (headers['content-encoding'] ?? 'identity') === 'identity' &&
          response.statusCode !== 204 &&
          response.statusCode !== 304
        if (tagged) delete headers['content-length']
        if (this.options.crossSiteCookies && headers['set-cookie'])
          headers['set-cookie'] = headers['set-cookie'].map(crossSiteCookie)
        // A redirect to the app's own path stays under its prefix.
        const location = headers.location
        if (target.prefix && location?.startsWith('/') && !location.startsWith('//'))
          headers.location = target.prefix + location
        res.writeHead(response.statusCode ?? 502, headers)
        if (tagged) pipeline(response, withSelectScript(), res, () => undefined)
        else response.pipe(res)
      },
    )
    upstream.on('error', () => {
      if (res.headersSent) return void res.destroy()
      if (isNavigation(req))
        res
          .writeHead(503, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
          })
          .end(waitingPage(this.options.state()))
      else res.writeHead(502, { 'content-type': 'text/plain' }).end('The app does not answer')
    })
    req.pipe(upstream)
  }

  /** WebSockets (hot reload, live data): the handshake as sent, then bytes both ways. */
  private upgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer) {
    this.used()
    const target = route(req.url ?? '/', this.options)
    if (!target) return void socket.destroy()
    const upstream = net.connect(target.port, this.options.host ?? '127.0.0.1', () => {
      const lines = [`${req.method} ${target.path} HTTP/${req.httpVersion}`]
      for (let i = 0; i < req.rawHeaders.length; i += 2)
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length) upstream.write(head)
      upstream.pipe(socket).pipe(upstream)
      // What the person sends on it is use, and wakes a frozen app; what the app sends
      // (a dev server's pings) is not, so a tab left open lets it freeze.
      socket.on('data', () => {
        this.used()
        void this.options.wake?.()
      })
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  }
}
