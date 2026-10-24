import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { test } from 'node:test'
import { PreviewProxy } from '../src/preview-proxy.js'

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

/**
 * An app in a process of its own that closes idle connections after 300 ms without
 * saying when it will (as Go's and Python's servers do), so the proxy keeps them.
 */
function app() {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `const s = require('node:http').createServer((req, res) => {
         res.setHeader('keep-alive', 'timeout=3600')
         res.end('ok ' + Date.now())
       })
       s.keepAliveTimeout = 300
       // Thawed by Linux's freezer, its wait is interrupted and those timeouts are long past.
       process.on('SIGCONT', () => s.closeIdleConnections())
       s.listen(0, '127.0.0.1', () => console.log(s.address().port))`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  )
  const port = new Promise<number>((done) =>
    child.stdout.once('data', (d: Buffer) => done(Number(d.toString().trim()))),
  )
  return { child, port }
}

function get(port: number) {
  return new Promise<{ status: number; body: string }>((done, fail) => {
    // A new connection each time: the browser's side does not matter here, the proxy's does.
    http
      .get({ host: '127.0.0.1', port, path: '/', agent: false }, (res) => {
        let body = ''
        res.on('data', (d: Buffer) => (body += d.toString()))
        res.on('end', () => done({ status: res.statusCode ?? 0, body }))
      })
      .on('error', fail)
  })
}

test('a request to a frozen app waits for it to wake, then gets its answer', async (t) => {
  const { child, port } = app()
  t.after(() => child.kill('SIGKILL'))
  let frozen = false
  let woken = 0
  let resumedAt = 0
  const proxy = new PreviewProxy({
    port: await port,
    ports: [],
    crossSiteCookies: false,
    state: () => 'running',
    onUse: () => undefined,
    // Thawing a cgroup: the app runs again at once, all its timers late, and closes its idle
    // connections while the runner is still busy (here, for 50 ms): the proxy has not seen
    // them close when it sends the request.
    wake: () => {
      if (!frozen) return undefined
      frozen = false
      woken++
      return sleep(100).then(() => {
        resumedAt = Date.now()
        child.kill('SIGCONT')
        while (Date.now() < resumedAt + 50);
      })
    },
  })
  t.after(() => proxy.close())
  const at = await proxy.listen(20_000 + Math.floor(Math.random() * 20_000), [])

  // Warm: the proxy keeps a connection to the app for the next request.
  for (let i = 0; i < 3; i++) assert.equal((await get(at)).status, 200)

  for (let round = 0; round < 5; round++) {
    // Frozen past its keep-alive: thawed, it closes those connections at once.
    child.kill('SIGSTOP')
    frozen = true
    await sleep(500)
    const answer = await get(at)
    assert.equal(answer.status, 200, `round ${round}: ${answer.body}`)
    assert.match(answer.body, /^ok \d+$/)
    // Answered by the app once it ran again, not before.
    assert.ok(Number(answer.body.slice(3)) >= resumedAt)
  }
  assert.equal(woken, 5)

  // Running: nothing to wake.
  assert.equal((await get(at)).status, 200)
  assert.equal(woken, 5)
})

test('a page the browser left before the app answered does not stop the proxy', async (t) => {
  // An app slow to render its page, as a dev server compiling after an edit.
  const server = http.createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html><head></head><body>page</body></html>')
    }, 200)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  t.after(() => server.close())
  const proxy = new PreviewProxy({
    port: (server.address() as { port: number }).port,
    ports: [],
    crossSiteCookies: false,
    state: () => 'running',
    onUse: () => undefined,
  })
  t.after(() => proxy.close())
  const at = await proxy.listen(20_000 + Math.floor(Math.random() * 20_000), [])

  // A reload or a navigation away: the browser closes the request before the page comes.
  const left = http.get({
    host: '127.0.0.1',
    port: at,
    path: '/',
    agent: false,
    headers: { 'sec-fetch-mode': 'navigate', accept: 'text/html' },
  })
  left.on('error', () => undefined)
  await sleep(50)
  left.destroy()
  await sleep(300)

  // Still answering, with the select script in the page.
  const page = await new Promise<string>((done, fail) => {
    http
      .get(
        { host: '127.0.0.1', port: at, path: '/', agent: false, headers: { accept: 'text/html' } },
        (res) => {
          let body = ''
          res.on('data', (d: Buffer) => (body += d.toString()))
          res.on('end', () => done(body))
        },
      )
      .on('error', fail)
  })
  assert.match(page, /page/)
})

test("behind the preview gateway, the app is asked for the gateway's host, WebSockets too", async (t) => {
  const seen: { host?: string; forwarded?: string }[] = []
  const server = http.createServer((req, res) => {
    seen.push({ host: req.headers.host, forwarded: req.headers['x-forwarded-host'] as string })
    res.end('ok')
  })
  server.on('upgrade', (req, socket) => {
    seen.push({ host: req.headers.host, forwarded: req.headers['x-forwarded-host'] as string })
    socket.end(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    )
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  t.after(() => server.close())
  const proxy = new PreviewProxy({
    port: (server.address() as { port: number }).port,
    ports: [],
    crossSiteCookies: true,
    publicHost: 'abc.brigade.surf',
    state: () => 'running',
    onUse: () => undefined,
  })
  t.after(() => proxy.close())
  const at = await proxy.listen(20_000 + Math.floor(Math.random() * 20_000), [])
  // As the provider forwards it: its own host in both.
  const provider = { host: 'box-1.on.boat.dev', 'x-forwarded-host': 'box-1.on.boat.dev' }

  await new Promise<void>((done, fail) => {
    http
      .get({ host: '127.0.0.1', port: at, path: '/', agent: false, headers: provider }, (res) =>
        res.resume().on('end', done),
      )
      .on('error', fail)
  })
  await new Promise<void>((done, fail) => {
    http
      .get({
        host: '127.0.0.1',
        port: at,
        path: '/hmr',
        agent: false,
        headers: { ...provider, connection: 'Upgrade', upgrade: 'websocket' },
      })
      .on('upgrade', (_res, socket) => {
        socket.destroy()
        done()
      })
      .on('error', fail)
  })
  assert.deepEqual(seen, [
    { host: 'abc.brigade.surf', forwarded: 'abc.brigade.surf' },
    { host: 'abc.brigade.surf', forwarded: 'abc.brigade.surf' },
  ])
})
