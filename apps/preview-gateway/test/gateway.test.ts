import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { afterEach, test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { ACCESS_COOKIE, accessToken, grantLabel, validAccess, validGrant } from '../src/access.ts'
import gateway, { hostOnly, routeId, withToken, withoutAccess, type Env } from '../src/index.ts'

const UPSTREAM = 'https://box-1-28000.on.boat.dev'
const THREAD = 'cmthreadaaaa0001'

/** D1 on SQLite in memory, with the gateway's migrations. */
function fakeDb() {
  const sqlite = new DatabaseSync(':memory:')
  const dir = new URL('../migrations/', import.meta.url)
  for (const file of readdirSync(dir).sort()) sqlite.exec(readFileSync(new URL(file, dir), 'utf8'))
  let reads = 0
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...values: unknown[]) => statement(sql, values),
    async first() {
      reads++
      return sqlite.prepare(sql).get(...(args as never[])) ?? null
    },
    async run() {
      return { success: true, results: sqlite.prepare(sql).all(...(args as never[])) }
    },
    sql,
    args,
  })
  const db = {
    prepare: (sql: string) => statement(sql),
    async batch(statements: ReturnType<typeof statement>[]) {
      sqlite.exec('BEGIN')
      try {
        const results = statements.map((s) => ({
          success: true,
          results: sqlite.prepare(s.sql).all(...(s.args as never[])),
        }))
        sqlite.exec('COMMIT')
        return results
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
  }
  const rows = () =>
    sqlite
      .prepare('SELECT id, thread, origin, token FROM previews')
      .all()
      .map((r) => ({ ...r }))
  return { db: db as unknown as D1Database, rows, reads: () => reads }
}

function envWith(db: D1Database): Env {
  return { DB: db, DOMAIN: 'brigade.surf', UPSTREAM_SUFFIX: '.on.boat.dev', SECRET: 's3cret' }
}

const call = (env: Env, input: string, init?: RequestInit) =>
  gateway.fetch(new Request(input, init) as never, env, {} as never) as Promise<Response>

const register = (env: Env, url: string, thread: string | null = THREAD, secret = env.SECRET) =>
  call(env, 'https://brigade.surf/routes', {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ url, thread }),
  })

const revoke = (env: Env, thread: string, secret = env.SECRET) =>
  call(env, 'https://brigade.surf/routes', {
    method: 'DELETE',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ thread }),
  })

/** Registered: its address here and its id. */
async function registered(env: Env, url = `${UPSTREAM}?_token=tok`, thread = THREAD) {
  const response = await register(env, url, thread)
  assert.equal(response.status, 200)
  const { origin } = (await response.json()) as { origin: string }
  return { origin, id: new URL(origin).hostname.split('.')[0]! }
}

const soon = () => Math.floor(Date.now() / 1000) + 300

/** The address the API hands out: with an access token for a few minutes. */
const withAccess = async (origin: string, path = '/', expires = soon()) => {
  const url = new URL(path, origin)
  url.searchParams.set(
    '_brigade',
    await accessToken('s3cret', new URL(origin).hostname.split('.')[0]!, expires),
  )
  return url.href
}

const navigate = { 'sec-fetch-mode': 'navigate', accept: 'text/html' }

/** A browser that keeps cookies opens the API's address: the cookie it ends up with. */
async function signIn(env: Env, origin: string) {
  const first = await call(env, await withAccess(origin), { headers: navigate })
  assert.equal(first.status, 302)
  const cookie = first.headers.get('set-cookie')!.split(';')[0]!
  const second = await call(env, first.headers.get('location')!, {
    headers: { ...navigate, cookie },
  })
  assert.equal(second.status, 302)
  assert.equal(second.headers.get('location'), `${origin}/`)
  return cookie
}

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const noProvider = () => {
  globalThis.fetch = (() => assert.fail('no request to the provider')) as typeof fetch
}

test('routeId: a DNS label, the same for the same thread and address, keyed with the secret', async () => {
  const id = await routeId('s3cret', THREAD, UPSTREAM)
  assert.match(id, /^[a-z2-7]{26}$/)
  assert.equal(await routeId('s3cret', THREAD, UPSTREAM), id)
  assert.notEqual(await routeId('other', THREAD, UPSTREAM), id)
  assert.notEqual(await routeId('s3cret', 'cmthreadbbbb0002', UPSTREAM), id)
  assert.notEqual(await routeId('s3cret', THREAD, 'https://box-2-28000.on.boat.dev'), id)
})

test('the access token is the one the API makes (apps/api/test/preview-gateway.test.ts)', async () => {
  const token = await accessToken('s3cret', 'a'.repeat(26), 2_000_000_000)
  assert.equal(token, '2000000000.d35xp4hezsfqynylnome5ps6ikrbirw5')
  assert.equal(await validAccess('s3cret', 'a'.repeat(26), token), true)
  assert.equal(await validAccess('s3cret', 'b'.repeat(26), token), false)
  assert.equal(await validAccess('other', 'a'.repeat(26), token), false)
  assert.equal(await validAccess('s3cret', 'a'.repeat(26), token.replace('2000', '2001')), false)
  const past = await accessToken('s3cret', 'a'.repeat(26), Math.floor(Date.now() / 1000) - 1)
  assert.equal(await validAccess('s3cret', 'a'.repeat(26), past), false)
})

test('a grant is a DNS label after the id, for one run of the preview, until it expires', async () => {
  const id = 'a'.repeat(26)
  const label = await grantLabel('s3cret', id, 'n1')
  assert.match(label, /^[a-z2-7]{26}-[a-z2-7]{36}$/)
  assert.ok(label.length <= 63)
  const grant = label.slice(27)
  assert.equal(await validGrant('s3cret', id, 'n1', grant), true)
  assert.equal(await validGrant('s3cret', id, 'n2', grant), false)
  assert.equal(await validGrant('s3cret', 'b'.repeat(26), 'n1', grant), false)
  const old = (await grantLabel('s3cret', id, 'n1', Math.floor(Date.now() / 1000) - 1)).slice(27)
  assert.equal(await validGrant('s3cret', id, 'n1', old), false)
})

test("withToken: the provider's token replaces the browser's, this site's cookie goes, others stay", () => {
  assert.equal(withToken(null, 't'), '_port_auth=t')
  assert.equal(
    withToken(`a=1; _port_auth=old; ${ACCESS_COOKIE}=x; b=2`, 't'),
    'a=1; b=2; _port_auth=t',
  )
})

test('hostOnly: an app cookie loses its Domain; the provider and this site keep theirs', () => {
  assert.equal(hostOnly('sid=1; Domain=brigade.surf; Path=/; HttpOnly'), 'sid=1; Path=/; HttpOnly')
  assert.equal(hostOnly('sid=1; domain=.brigade.surf'), 'sid=1')
  assert.equal(hostOnly('sid=1; Path=/'), 'sid=1; Path=/')
  assert.equal(hostOnly('_port_auth=x; Path=/'), null)
  assert.equal(hostOnly(`${ACCESS_COOKIE}=x; Path=/`), null)
})

test("withoutAccess: this site's parameters go, the rest stays as it came", () => {
  assert.equal(withoutAccess('?_brigade=x&a=b%20c&_brigade_cookie=1'), '?a=b%20c')
  assert.equal(withoutAccess('?_brigade=x'), '')
  assert.equal(withoutAccess(''), '')
})

test('registering needs the secret, the thread and a provider address with its token', async () => {
  const { db, rows } = fakeDb()
  const env = envWith(db)
  assert.equal((await register(env, `${UPSTREAM}/?_token=abc`, THREAD, 'wrong')).status, 401)
  assert.equal((await register(env, 'https://evil.example/?_token=abc')).status, 400)
  assert.equal((await register(env, `${UPSTREAM}/`)).status, 400)
  assert.equal((await register(env, `http://box-1-28000.on.boat.dev/?_token=abc`)).status, 400)
  // An API from before: no thread, so no route; it then hands out the provider's address.
  assert.equal((await register(env, `${UPSTREAM}?_token=abc`, null)).status, 400)
  assert.equal((await register(env, `${UPSTREAM}?_token=abc`, 'a b')).status, 400)
  assert.equal(rows().length, 0)

  const { origin } = await registered(env, `${UPSTREAM}?_token=abc`)
  assert.equal(origin, `https://${await routeId('s3cret', THREAD, UPSTREAM)}.brigade.surf`)
  assert.deepEqual(rows(), [
    {
      id: await routeId('s3cret', THREAD, UPSTREAM),
      thread: THREAD,
      origin: UPSTREAM,
      token: 'abc',
    },
  ])
})

test("another thread at the same provider's address gets its own address, and the first one's goes", async () => {
  const { db, rows } = fakeDb()
  const env = envWith(db)
  const a = await registered(env)
  const cookie = await signIn(env, a.origin)
  const b = await registered(env, `${UPSTREAM}?_token=tok`, 'cmthreadbbbb0002')
  assert.notEqual(a.origin, b.origin)
  assert.equal(rows().length, 1)
  noProvider()
  // The first thread's address no longer reaches the app on that port, cookie or not.
  assert.equal((await call(env, `${a.origin}/`, { headers: { cookie } })).status, 404)
  // Nor is its cookie good at the second's.
  assert.equal((await call(env, `${b.origin}/`, { headers: { cookie } })).status, 403)

  // A thread's preview at another address: its route moves there.
  await registered(env, 'https://box-1-28001.on.boat.dev?_token=t2', 'cmthreadbbbb0002')
  assert.deepEqual(
    rows().map((r) => r.origin),
    ['https://box-1-28001.on.boat.dev'],
  )
})

test('without access: a page that says to open it from Brigade, and nothing reaches the provider', async () => {
  const { db } = fakeDb()
  const env = envWith(db)
  const { origin } = await registered(env)
  noProvider()
  const page = await call(env, `${origin}/`, { headers: navigate })
  assert.equal(page.status, 403)
  assert.match(page.headers.get('content-type')!, /text\/html/)
  assert.match(await page.text(), /Open this preview from Brigade/)
  const script = await call(env, `${origin}/app.js`, { headers: { 'sec-fetch-mode': 'no-cors' } })
  assert.equal(script.status, 403)
  assert.match(script.headers.get('content-type')!, /text\/plain/)
  // Expired, or for another preview.
  assert.equal((await call(env, await withAccess(origin, '/', 1000))).status, 403)
  const other = new URL(origin)
  other.searchParams.set('_brigade', await accessToken('s3cret', 'a'.repeat(26), soon()))
  assert.equal((await call(env, other.href)).status, 403)
  // A cookie made up, or an old one's value with another expiry.
  assert.equal(
    (
      await call(env, `${origin}/`, {
        headers: { cookie: `${ACCESS_COOKIE}=99999999999.${'a'.repeat(32)}` },
      })
    ).status,
    403,
  )
  // A grant made up.
  const grant = origin.replace('.brigade.surf', `-${'a'.repeat(36)}.brigade.surf`)
  assert.equal((await call(env, `${grant}/`)).status, 403)
})

test('the access token becomes a cookie for this host only, then the address without it', async () => {
  const { db } = fakeDb()
  const env = envWith(db)
  const { origin } = await registered(env)
  noProvider()
  const first = await call(env, await withAccess(origin, '/app?tab=2'), { headers: navigate })
  assert.equal(first.status, 302)
  const tried = new URL(first.headers.get('location')!)
  assert.equal(tried.origin, origin)
  assert.equal(tried.pathname, '/app')
  assert.equal(tried.searchParams.get('_brigade_cookie'), '1')
  const set = first.headers.get('set-cookie')!
  assert.match(set, new RegExp(`^${ACCESS_COOKIE}=`))
  for (const attribute of ['Path=/', 'Secure', 'HttpOnly', 'SameSite=None', 'Partitioned'])
    assert.ok(set.includes(attribute), attribute)
  assert.doesNotMatch(set, /Domain/i)
  // The cookie came back: the address as it was, without the token.
  const second = await call(env, tried.href, {
    headers: { ...navigate, cookie: set.split(';')[0]! },
  })
  assert.equal(second.status, 302)
  assert.equal(second.headers.get('location'), `${origin}/app?tab=2`)
})

test('a request with the cookie goes to the provider with its token, without the cookie', async () => {
  const { db, reads } = fakeDb()
  const env = envWith(db)
  const { origin } = await registered(env)
  const cookie = await signIn(env, origin)
  const seen: Request[] = []
  globalThis.fetch = (async (input: URL, init: RequestInit) => {
    seen.push(new Request(input, init))
    return new Response(null, { status: 302, headers: { location: `${UPSTREAM}/next?x=1` } })
  }) as typeof fetch

  const response = await call(env, `${origin}/app.js?v=2`, {
    headers: { cookie: `sid=1; ${cookie}` },
  })
  assert.equal(seen[0]!.url, `${UPSTREAM}/app.js?v=2`)
  assert.equal(seen[0]!.headers.get('cookie'), 'sid=1; _port_auth=tok')
  assert.equal(seen[0]!.redirect, 'manual')
  assert.equal(response.headers.get('location'), `${origin}/next?x=1`)

  // Each request reads its route, none is kept; a page's requests at the same time share one read.
  const before = reads()
  await call(env, `${origin}/other.css`, { headers: { cookie } })
  assert.equal(reads(), before + 1)
  await Promise.all(
    ['/a.js', '/b.js', '/c.css'].map((path) =>
      call(env, `${origin}${path}`, { headers: { cookie } }),
    ),
  )
  assert.equal(reads(), before + 2)
})

test("where the browser drops the cookie (Safari's frame), a grant in the host lets it in", async () => {
  const { db } = fakeDb()
  const env = envWith(db)
  const { origin, id } = await registered(env)
  const first = await call(env, await withAccess(origin, '/app?tab=2'), { headers: navigate })
  // Back without the cookie.
  const second = await call(env, first.headers.get('location')!, { headers: navigate })
  assert.equal(second.status, 302)
  const at = new URL(second.headers.get('location')!)
  assert.match(at.hostname, new RegExp(`^${id}-[a-z2-7]{36}\\.brigade\\.surf$`))
  assert.equal(at.pathname + at.search, '/app?tab=2')

  // The headers only: Node wants a streamed body's duplex, which Workers do not.
  const seen: { headers: Headers }[] = []
  globalThis.fetch = (async (_input: URL, init: RequestInit) => {
    seen.push({ headers: new Headers(init.headers) })
    return new Response('ok', {
      status: 303,
      headers: [
        ['location', `${origin}/done`],
        ['set-cookie', 'sid=1; Domain=brigade.surf; Path=/'],
      ],
    })
  }) as typeof fetch
  const response = await call(env, `${at.origin}/api/save`, {
    method: 'POST',
    headers: { origin: at.origin, referer: `${at.origin}/app?tab=2` },
    body: '{}',
  })
  // The app sees the preview's address, as it was told (the runner's proxy, BRIGADE_PREVIEW_URL).
  assert.equal(seen[0]!.headers.get('origin'), origin)
  assert.equal(seen[0]!.headers.get('referer'), `${origin}/app?tab=2`)
  // Its redirects to that address stay at the grant; its cookies are the grant host's own.
  assert.equal(response.headers.get('location'), `${at.origin}/done`)
  assert.equal(response.headers.get('set-cookie'), 'sid=1; Path=/')

  // An access token opened again at the grant goes.
  const again = await call(env, `${at.origin}/?_brigade=x`)
  assert.equal(again.status, 302)
  assert.equal(again.headers.get('location'), `${at.origin}/`)
})

test("a page at a grant may ask the preview's own address (CORS), as the same app", async () => {
  const { db } = fakeDb()
  const env = envWith(db)
  const { origin, id } = await registered(env)
  const grant = `https://${await grantLabel('s3cret', id, (await nonceOf(env, origin))!)}.brigade.surf`
  noProvider()
  const preflight = await call(env, `${origin}/__ports/3001/items`, {
    method: 'OPTIONS',
    headers: {
      origin: grant,
      'access-control-request-method': 'PUT',
      'access-control-request-headers': 'content-type',
    },
  })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), grant)
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'PUT')

  const seen: Request[] = []
  globalThis.fetch = (async (input: URL, init: RequestInit) => {
    seen.push(new Request(input, init))
    return Response.json([])
  }) as typeof fetch
  const response = await call(env, `${origin}/__ports/3001/items`, { headers: { origin: grant } })
  assert.equal(response.status, 200)
  assert.equal(seen[0]!.headers.get('origin'), origin)
  assert.equal(response.headers.get('access-control-allow-origin'), grant)
  // Another preview's grant, or a grant made up, is not this one.
  const elsewhere = `https://${await grantLabel('s3cret', 'a'.repeat(26), 'n')}.brigade.surf`
  assert.equal((await call(env, `${origin}/x`, { headers: { origin: elsewhere } })).status, 403)
})

/** The nonce of a route, from what lets a person in: a grant made for it validates. */
async function nonceOf(env: Env, origin: string) {
  const row = await env.DB.prepare('SELECT nonce FROM previews WHERE id = ?')
    .bind(new URL(origin).hostname.split('.')[0])
    .first<{ nonce: string }>()
  return row?.nonce
}

test("a stopped preview's address answers 404; started again, the run before's cookie and grant are refused", async () => {
  const { db } = fakeDb()
  const env = envWith(db)
  const { origin, id } = await registered(env)
  const cookie = await signIn(env, origin)
  const grant = `https://${await grantLabel('s3cret', id, (await nonceOf(env, origin))!)}.brigade.surf`
  assert.equal((await revoke(env, THREAD, 'wrong')).status, 401)
  assert.equal((await revoke(env, THREAD)).status, 204)
  noProvider()
  assert.equal((await call(env, `${origin}/`, { headers: { cookie } })).status, 404)
  assert.equal((await call(env, `${grant}/`)).status, 404)

  // The same thread's next run: the same address, a new nonce.
  assert.equal((await registered(env)).origin, origin)
  assert.equal((await call(env, `${origin}/`, { headers: { cookie } })).status, 403)
  assert.equal((await call(env, `${grant}/`)).status, 403)
  // Registered again while it runs (another person opens it): the cookie stays good.
  const fresh = await signIn(env, origin)
  await registered(env)
  globalThis.fetch = (async () => new Response('ok')) as typeof fetch
  assert.equal((await call(env, `${origin}/`, { headers: { cookie: fresh } })).status, 200)
})

test("dropped in another isolate, a route lets its cookie and grant in nowhere, the next thread's app least of all", async () => {
  // Two isolates of the gateway on one database: a module of its own each.
  const other = (await import('../src/index.ts?another-isolate')).default
  const callOther = (env: Env, input: string, init?: RequestInit) =>
    other.fetch(new Request(input, init) as never, env, {} as never) as Promise<Response>
  const { db, rows } = fakeDb()
  const env = envWith(db)
  const { origin, id } = await registered(env)
  const cookie = await signIn(env, origin)
  const grant = `https://${await grantLabel('s3cret', id, (await nonceOf(env, origin))!)}.brigade.surf`
  // This isolate has served the route.
  globalThis.fetch = (async () => new Response('thread A')) as typeof fetch
  assert.equal((await call(env, `${origin}/`, { headers: { cookie } })).status, 200)
  assert.equal((await call(env, `${grant}/`)).status, 200)

  // The other one drops it, and a private thread's preview takes the provider's address.
  const json = { authorization: 'Bearer s3cret', 'content-type': 'application/json' }
  const routes = 'https://brigade.surf/routes'
  const body = (value: unknown) => JSON.stringify(value)
  assert.equal(
    (
      await callOther(env, routes, {
        method: 'DELETE',
        headers: json,
        body: body({ thread: THREAD }),
      })
    ).status,
    204,
  )
  const taken = await callOther(env, routes, {
    method: 'POST',
    headers: json,
    body: body({ thread: 'cmthreadbbbb0002', url: `${UPSTREAM}?_token=tok` }),
  })
  assert.equal(taken.status, 200)
  assert.deepEqual(
    rows().map((r) => r.thread),
    ['cmthreadbbbb0002'],
  )

  noProvider()
  assert.equal((await call(env, `${origin}/`, { headers: { cookie } })).status, 404)
  assert.equal((await call(env, `${grant}/`)).status, 404)
})

test('an unknown id, a deeper host or the apex answers 404 without reaching the provider', async () => {
  const { db } = fakeDb()
  const env = envWith(db)
  noProvider()
  assert.equal((await call(env, `https://${'a'.repeat(26)}.brigade.surf/`)).status, 404)
  assert.equal((await call(env, 'https://x.y.brigade.surf/')).status, 404)
  assert.equal((await call(env, 'https://brigade.surf/')).status, 404)
  assert.equal((await call(env, 'https://brigade.surf/routes')).status, 404)
})

test('the provider down answers 502', async () => {
  const { db } = fakeDb()
  const env = envWith(db)
  const { origin } = await registered(env)
  const cookie = await signIn(env, origin)
  globalThis.fetch = (async () => {
    throw new Error('connection refused')
  }) as typeof fetch
  assert.equal((await call(env, `${origin}/`, { headers: { cookie } })).status, 502)
})

test('a path that starts with // stays on the provider, with the cookies', async () => {
  const { db } = fakeDb()
  const env = envWith(db)
  const { origin } = await registered(env)
  const cookie = await signIn(env, origin)
  const seen: string[] = []
  globalThis.fetch = (async (input: URL) => {
    seen.push(String(input))
    return new Response('ok')
  }) as typeof fetch
  await call(env, `${origin}//attacker.example/collect?x=1`, {
    headers: { cookie: `sid=1; ${cookie}` },
  })
  assert.equal(new URL(seen[0]!).origin, UPSTREAM)
  assert.equal(seen[0], `${UPSTREAM}//attacker.example/collect?x=1`)
})

test('answers keep the host out of Referers, whatever the app says; other redirects stay', async () => {
  const { db } = fakeDb()
  const env = envWith(db)
  const { origin } = await registered(env)
  const cookie = await signIn(env, origin)
  const lookalike = `${UPSTREAM}.evil.example/x`
  globalThis.fetch = (async () =>
    new Response(null, {
      status: 302,
      headers: { location: lookalike, 'referrer-policy': 'unsafe-url' },
    })) as typeof fetch
  const response = await call(env, `${origin}/`, { headers: { cookie } })
  assert.equal(response.headers.get('referrer-policy'), 'same-origin')
  assert.equal(response.headers.get('location'), lookalike)
})

test("a WebSocket from the preview's own page goes with the provider's origin; another is refused", async () => {
  const { db } = fakeDb()
  const env = envWith(db)
  const { origin } = await registered(env)
  const cookie = await signIn(env, origin)
  // The headers only: Node wants a streamed body's duplex, which Workers do not.
  const seen: { headers: Headers }[] = []
  globalThis.fetch = (async (_input: URL, init: RequestInit) => {
    seen.push({ headers: new Headers(init.headers) })
    return new Response('ok')
  }) as typeof fetch
  const ws = { upgrade: 'websocket', connection: 'Upgrade', cookie }
  await call(env, `${origin}/_next/hmr`, { headers: { ...ws, origin } })
  assert.equal(seen[0]!.headers.get('origin'), UPSTREAM)

  const refused = await call(env, `${origin}/_next/hmr`, {
    headers: { ...ws, origin: 'https://evil.example' },
  })
  assert.equal(refused.status, 403)
  assert.equal(seen.length, 1)

  // Not a WebSocket: its origin as it came (the provider checks none).
  await call(env, `${origin}/api`, {
    method: 'POST',
    headers: { origin, cookie },
    body: '{}',
  })
  assert.equal(seen[1]!.headers.get('origin'), origin)
})

test('answers are asked for again before use, whatever the provider made of their cache time', async () => {
  const { db } = fakeDb()
  const env = envWith(db)
  const { origin } = await registered(env)
  const cookie = await signIn(env, origin)
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
  const headers = { cookie }
  const chunk = await call(env, `${origin}/_next/static/chunks/app.js`, { headers })
  assert.equal(chunk.headers.get('cache-control'), 'private, no-cache')
  const none = await call(env, `${origin}/favicon.ico`, { headers })
  assert.equal(none.headers.get('cache-control'), 'private, no-cache')
  const page = await call(env, `${origin}/`, { headers })
  assert.equal(page.headers.get('cache-control'), 'no-store')
})
