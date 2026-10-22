import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { PreviewProxy } from '../src/preview-proxy.js'
import { SELECT_SCRIPT, SELECT_SCRIPT_PATH } from '../src/preview-select.js'

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

test('the proxy serves the script itself', async (t) => {
  const { at, seen } = await app(t)
  const script = await get(at, SELECT_SCRIPT_PATH)
  assert.equal(script.status, 200)
  assert.match(script.headers['content-type'] ?? '', /javascript/)
  assert.equal(script.body, SELECT_SCRIPT)
  assert.equal(seen.length, 0)
  // It parses as a script.
  assert.doesNotThrow(() => new Function(SELECT_SCRIPT))
})
