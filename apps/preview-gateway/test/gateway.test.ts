import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import gateway, { routeId, withToken, type Env } from '../src/index.ts'

const UPSTREAM = 'https://box-1-28000.on.boat.dev'

/** D1 with the one table, in memory. */
function fakeDb() {
  const rows = new Map<string, { origin: string; token: string }>()
  let reads = 0
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first() {
              reads++
              return rows.get(args[0] as string) ?? null
            },
            async run() {
              assert.match(sql, /INSERT INTO routes/)
              rows.set(args[0] as string, { origin: args[1] as string, token: args[2] as string })
              return { success: true }
            },
          }
        },
      }
    },
  }
  return { db: db as unknown as D1Database, rows, reads: () => reads }
}

function envWith(db: D1Database): Env {
  return { DB: db, DOMAIN: 'brigade.surf', UPSTREAM_SUFFIX: '.on.boat.dev', SECRET: 's3cret' }
}

const call = (env: Env, input: string, init?: RequestInit) =>
  gateway.fetch(new Request(input, init) as never, env, {} as never) as Promise<Response>

const register = (env: Env, url: string, secret = env.SECRET) =>
  call(env, 'https://brigade.surf/routes', {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  })

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

test('routeId: a DNS label, the same for the same address, keyed with the secret', async () => {
  const id = await routeId('s3cret', UPSTREAM)
  assert.match(id, /^[a-z2-7]{26}$/)
  assert.equal(await routeId('s3cret', UPSTREAM), id)
  assert.notEqual(await routeId('other', UPSTREAM), id)
  assert.notEqual(await routeId('s3cret', 'https://box-2-28000.on.boat.dev'), id)
})

test("withToken: the provider's token replaces the browser's, other cookies stay", () => {
  assert.equal(withToken(null, 't'), '_port_auth=t')
  assert.equal(withToken('a=1; _port_auth=old; b=2', 't'), 'a=1; b=2; _port_auth=t')
})

test('registering needs the secret and a provider address with its token', async () => {
  const { db, rows } = fakeDb()
  const env = envWith(db)
  assert.equal((await register(env, `${UPSTREAM}/?_token=abc`, 'wrong')).status, 401)
  assert.equal((await register(env, 'https://evil.example/?_token=abc')).status, 400)
  assert.equal((await register(env, `${UPSTREAM}/`)).status, 400)
  assert.equal((await register(env, `http://box-1-28000.on.boat.dev/?_token=abc`)).status, 400)
  assert.equal(rows.size, 0)

  const response = await register(env, `${UPSTREAM}?_token=abc`)
  assert.equal(response.status, 200)
  const { origin } = (await response.json()) as { origin: string }
  assert.equal(origin, `https://${await routeId('s3cret', UPSTREAM)}.brigade.surf`)
  assert.deepEqual([...rows.values()], [{ origin: UPSTREAM, token: 'abc' }])
})

test('a request goes to the provider with the token; its redirects stay here', async () => {
  const { db, reads } = fakeDb()
  const env = envWith(db)
  const { origin } = (await (await register(env, `${UPSTREAM}?_token=tok`)).json()) as {
    origin: string
  }
  const seen: Request[] = []
  globalThis.fetch = (async (input: URL, init: RequestInit) => {
    seen.push(new Request(input, init))
    return new Response(null, { status: 302, headers: { location: `${UPSTREAM}/next?x=1` } })
  }) as typeof fetch

  const response = await call(env, `${origin}/app.js?v=2`, { headers: { cookie: 'sid=1' } })
  assert.equal(seen[0]!.url, `${UPSTREAM}/app.js?v=2`)
  assert.equal(seen[0]!.headers.get('cookie'), 'sid=1; _port_auth=tok')
  assert.equal(seen[0]!.redirect, 'manual')
  assert.equal(response.headers.get('location'), `${origin}/next?x=1`)

  // Registered in this isolate: no read of the database for its requests.
  await call(env, `${origin}/other.css`)
  assert.equal(reads(), 0)
})

test('an unknown id, a deeper host or the apex answers 404 without reaching the provider', async () => {
  const { db } = fakeDb()
  const env = envWith(db)
  globalThis.fetch = (() => assert.fail('no request to the provider')) as typeof fetch
  assert.equal((await call(env, `https://${'a'.repeat(26)}.brigade.surf/`)).status, 404)
  assert.equal((await call(env, 'https://x.y.brigade.surf/')).status, 404)
  assert.equal((await call(env, 'https://brigade.surf/')).status, 404)
  assert.equal((await call(env, 'https://brigade.surf/routes')).status, 404)
})

test('the provider down answers 502', async () => {
  const { db } = fakeDb()
  const env = envWith(db)
  const { origin } = (await (await register(env, `${UPSTREAM}?_token=tok`)).json()) as {
    origin: string
  }
  globalThis.fetch = (async () => {
    throw new Error('connection refused')
  }) as typeof fetch
  assert.equal((await call(env, `${origin}/`)).status, 502)
})

test('a path that starts with // stays on the provider, with the cookies', async () => {
  const { db } = fakeDb()
  const env = envWith(db)
  const { origin } = (await (await register(env, `${UPSTREAM}?_token=tok`)).json()) as {
    origin: string
  }
  const seen: string[] = []
  globalThis.fetch = (async (input: URL) => {
    seen.push(String(input))
    return new Response('ok')
  }) as typeof fetch
  await call(env, `${origin}//attacker.example/collect?x=1`, { headers: { cookie: 'sid=1' } })
  assert.equal(new URL(seen[0]!).origin, UPSTREAM)
  assert.equal(seen[0], `${UPSTREAM}//attacker.example/collect?x=1`)
})

test('answers keep the host out of Referers, whatever the app says; other redirects stay', async () => {
  const { db } = fakeDb()
  const env = envWith(db)
  const { origin } = (await (await register(env, `${UPSTREAM}?_token=tok`)).json()) as {
    origin: string
  }
  const lookalike = `${UPSTREAM}.evil.example/x`
  globalThis.fetch = (async () =>
    new Response(null, {
      status: 302,
      headers: { location: lookalike, 'referrer-policy': 'unsafe-url' },
    })) as typeof fetch
  const response = await call(env, `${origin}/`)
  assert.equal(response.headers.get('referrer-policy'), 'same-origin')
  assert.equal(response.headers.get('location'), lookalike)
})

test("a WebSocket from the preview's own page goes with the provider's origin; another is refused", async () => {
  const { db } = fakeDb()
  const env = envWith(db)
  const { origin } = (await (await register(env, `${UPSTREAM}?_token=tok`)).json()) as {
    origin: string
  }
  // The headers only: Node wants a streamed body's duplex, which Workers do not.
  const seen: { headers: Headers }[] = []
  globalThis.fetch = (async (_input: URL, init: RequestInit) => {
    seen.push({ headers: new Headers(init.headers) })
    return new Response('ok')
  }) as typeof fetch
  const ws = { upgrade: 'websocket', connection: 'Upgrade' }
  await call(env, `${origin}/_next/hmr`, { headers: { ...ws, origin } })
  assert.equal(seen[0]!.headers.get('origin'), UPSTREAM)

  const refused = await call(env, `${origin}/_next/hmr`, {
    headers: { ...ws, origin: 'https://evil.example' },
  })
  assert.equal(refused.status, 403)
  assert.equal(seen.length, 1)

  // Not a WebSocket: its origin as it came (the provider checks none).
  await call(env, `${origin}/api`, { method: 'POST', headers: { origin }, body: '{}' })
  assert.equal(seen[1]!.headers.get('origin'), origin)
})

test('answers are asked for again before use, whatever the provider made of their cache time', async () => {
  const { db } = fakeDb()
  const env = envWith(db)
  const { origin } = (await (await register(env, `${UPSTREAM}?_token=tok`)).json()) as {
    origin: string
  }
  const answers = [
    // A dev server's chunk: its no-cache, made four hours by the provider's Cloudflare.
    'max-age=14400, must-revalidate',
    null,
    'no-store',
  ]
  globalThis.fetch = (async () => {
    const cacheControl = answers.shift()
    return new Response('x', { headers: cacheControl ? { 'cache-control': cacheControl } : {} })
  }) as typeof fetch
  const chunk = await call(env, `${origin}/_next/static/chunks/app.js`)
  assert.equal(chunk.headers.get('cache-control'), 'private, no-cache')
  const none = await call(env, `${origin}/favicon.ico`)
  assert.equal(none.headers.get('cache-control'), 'private, no-cache')
  const page = await call(env, `${origin}/`)
  assert.equal(page.headers.get('cache-control'), 'no-store')
})
