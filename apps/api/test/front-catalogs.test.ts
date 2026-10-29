import assert from 'node:assert/strict'
import { test } from 'node:test'

// The front (src/front.ts) sends an App's catalog to the API Worker's own isolates whatever
// STATELESS_ROUTES says, never to the Api object, unless the isolates fail it; other requests
// go where they went.
const { default: front } = await import('../src/front.js')
const { STATELESS_HEADER } = await import('../src/hub/route.js')

function env(isolates: (request: Request) => Promise<Response>) {
  const seen = { isolates: [] as Request[], object: [] as Request[] }
  const api = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (request: Request) => {
        seen.object.push(request)
        return new Response('object')
      },
    }),
  }
  const worker = {
    fetch: async (request: Request) => {
      seen.isolates.push(request)
      return isolates(request)
    },
  }
  return {
    seen,
    env: { API: api, API_WORKER: worker, WEB_URL: 'https://app.test', STATELESS_ROUTES: '' },
  }
}

const call = (url: string, e: unknown, init?: RequestInit) =>
  (front as { fetch: (r: Request, e: unknown) => Promise<Response> }).fetch(
    new Request(url, init),
    e,
  )

test("an App's catalog runs in the isolates, not the Api object", async () => {
  const { seen, env: e } = env(async () => new Response('[]'))
  const res = await call('https://api.test/runner/catalogs/c1?scope=read&version=v', e)
  assert.equal(await res.text(), '[]')
  assert.equal(seen.isolates.length, 1)
  assert.equal(seen.isolates[0]!.headers.get(STATELESS_HEADER), '1')
  assert.equal(seen.object.length, 0)
})

test('the Api object answers when the isolates fail it', async () => {
  const failing = env(async () => new Response('down', { status: 503 }))
  const res = await call('https://api.test/runner/catalogs/c1?scope=read&version=v', failing.env)
  assert.equal(await res.text(), 'object')
  assert.equal(failing.seen.object.length, 1)
  const throwing = env(async () => {
    throw new Error('gone')
  })
  const again = await call('https://api.test/runner/catalogs/c1?scope=read', throwing.env)
  assert.equal(await again.text(), 'object')
})

test('other requests go where they went', async () => {
  const { seen, env: e } = env(async () => new Response('isolate'))
  await call('https://api.test/api/threads', e)
  await call('https://api.test/runner/spec-parts/abc', e)
  await call('https://api.test/runner/catalogs/c1?scope=read', e, { method: 'POST' })
  assert.equal(seen.isolates.length, 0)
  assert.equal(seen.object.length, 3)
})
