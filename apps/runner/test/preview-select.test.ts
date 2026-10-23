import vm from 'node:vm'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { PreviewProxy } from '../src/preview-proxy.js'
import { SCREENSHOT_SCRIPT_PATH, SELECT_SCRIPT, SELECT_SCRIPT_PATH } from '../src/preview-select.js'

const TAG = `<script src="${SELECT_SCRIPT_PATH}"></script>`

/** An app whose page streams its <head> in two pieces, and an API answering JSON. */
async function app(t: test.TestContext) {
  const seen: (string | undefined)[] = []
  const server = http.createServer((req, res) => {
    seen.push(req.headers['accept-encoding'])
    if (req.url === '/api') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '2' })
      return void res.end('{}')
    }
    const [start, end] = ['<!doctype html><html lang="fr"><he', 'ad><title>é</title></head>']
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(Buffer.byteLength(start + end)),
    })
    res.write(start)
    setTimeout(() => res.end(end), 20)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  t.after(() => server.close())
  const proxy = new PreviewProxy({
    port: (server.address() as AddressInfo).port,
    ports: [],
    crossSiteCookies: false,
    state: () => 'running',
    onUse: () => undefined,
  })
  t.after(() => proxy.close())
  const at = await proxy.listen(20_000 + Math.floor(Math.random() * 20_000), [])
  return { at, seen }
}

function get(port: number, path: string, headers: http.OutgoingHttpHeaders = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>(
    (done, fail) => {
      http
        .get({ host: '127.0.0.1', port, path, headers, agent: false }, (res) => {
          const chunks: Buffer[] = []
          res.on('data', (d: Buffer) => chunks.push(d))
          res.on('end', () =>
            done({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString(),
            }),
          )
        })
        .on('error', fail)
    },
  )
}

test('a page gets the select script after its <head>, uncompressed; data does not', async (t) => {
  const { at, seen } = await app(t)
  const page = await get(at, '/', {
    'sec-fetch-mode': 'navigate',
    accept: 'text/html',
    'accept-encoding': 'gzip, br',
  })
  assert.equal(page.body, `<!doctype html><html lang="fr"><head>${TAG}<title>é</title></head>`)
  assert.equal(page.headers['content-length'], undefined)
  assert.equal(seen[0], 'identity')

  const data = await get(at, '/api', { accept: 'application/json', 'accept-encoding': 'gzip' })
  assert.equal(data.body, '{}')
  assert.equal(seen[1], 'gzip')
})

test('the proxy serves the scripts itself', async (t) => {
  const { at, seen } = await app(t)
  const script = await get(at, SELECT_SCRIPT_PATH)
  assert.equal(script.status, 200)
  assert.match(script.headers['content-type'] ?? '', /javascript/)
  assert.equal(script.body, SELECT_SCRIPT)
  assert.equal(seen.length, 0)
  // It parses as a script.
  assert.doesNotThrow(() => new Function(SELECT_SCRIPT))
  // And the library that draws an element, a module with no imports.
  const drawing = await get(at, SCREENSHOT_SCRIPT_PATH)
  assert.equal(drawing.status, 200)
  assert.match(drawing.body, /export \{[^}]*domToBlob/)
  assert.doesNotMatch(drawing.body, /^import /m)
})

/** The script in a page framed by the dashboard: what it posts to the panel, and where it goes. */
function framedPage(path: string) {
  const posted: { message: Record<string, unknown>; to: string }[] = []
  const listeners = new Map<string, ((e: unknown) => void)[]>()
  const parent = {
    postMessage: (message: Record<string, unknown>, to: string) =>
      // Out of the page's realm, for deepEqual.
      posted.push({ message: JSON.parse(JSON.stringify(message)) as Record<string, unknown>, to }),
  }
  const at = new URL(path, 'https://box.example')
  const location = {
    get href() {
      return at.href
    },
    get origin() {
      return at.origin
    },
    get pathname() {
      return at.pathname
    },
    get search() {
      return at.search
    },
    get hash() {
      return at.hash
    },
    assigned: [] as string[],
    assign(to: string) {
      this.assigned.push(to)
    },
  }
  const history = {
    pushState(_state: unknown, _title: string, to: string) {
      at.href = new URL(to, at).href
    },
    replaceState(_state: unknown, _title: string, to: string) {
      at.href = new URL(to, at).href
    },
  }
  const window: Record<string, unknown> = {
    parent,
    location,
    history,
    document: { currentScript: null },
    URL,
    addEventListener: (type: string, listener: (e: unknown) => void) =>
      listeners.set(type, [...(listeners.get(type) ?? []), listener]),
  }
  window.window = window
  vm.runInNewContext(SELECT_SCRIPT, window)
  const fromPanel = (data: unknown) =>
    listeners
      .get('message')
      ?.forEach((l) => l({ data, source: parent, origin: 'https://dash.example' }))
  return { posted, location, history, fromPanel }
}

test('the page tells the panel where it is, and opens the path typed there', () => {
  const page = framedPage('/app?tab=2')
  assert.deepEqual(page.posted, [
    { message: { source: 'brigade-preview', type: 'ready' }, to: '*' },
  ])
  page.fromPanel({ source: 'brigade', type: 'hello' })
  assert.deepEqual(page.posted[1], {
    message: { source: 'brigade-preview', type: 'location', page: '/app?tab=2' },
    to: 'https://dash.example',
  })
  // A client-side navigation is said too, once.
  page.history.pushState(null, '', '/app/settings')
  page.history.replaceState(null, '', '/app/settings')
  assert.equal(page.posted.length, 3)
  assert.equal(page.posted[2]!.message.page, '/app/settings')

  page.fromPanel({ source: 'brigade', type: 'navigate', page: '/login' })
  // Only a path on its own address.
  page.fromPanel({ source: 'brigade', type: 'navigate', page: '//evil.example/x' })
  page.fromPanel({ source: 'brigade', type: 'navigate', page: '/\\evil.example/' })
  page.fromPanel({ source: 'brigade', type: 'navigate', page: 'javascript:alert(1)' })
  assert.deepEqual(page.location.assigned, ['https://box.example/login'])
})
