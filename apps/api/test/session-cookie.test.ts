import assert from 'node:assert/strict'
import { test } from 'node:test'
import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { Hono } from 'hono'
import { userFrom, type AppEnv } from '../src/scope.js'

// requireUser (src/scope.ts) keeps the browser's cookie alive with the session: once a day,
// reading the session renews both, and the renewed cookie must reach the browser. Before, it
// stayed in Better Auth's answer, and the cookie died 7 days after sign-in however often the
// person came back. On better-auth with an in-memory database, as in desktop-sign-in.test.ts.
const ORIGIN = 'http://localhost:3000'
const DAY = 24 * 60 * 60 * 1000

function setup() {
  const db: Record<string, Record<string, unknown>[]> = {
    user: [],
    session: [],
    account: [],
    verification: [],
  }
  const auth = betterAuth({
    baseURL: 'http://localhost:3001',
    basePath: '/api/auth',
    secret: 'test-secret-test-secret-test-secret',
    trustedOrigins: [ORIGIN],
    database: memoryAdapter(db),
    emailAndPassword: { enabled: true },
  })
  const app = new Hono<AppEnv>()
    .use(userFrom((headers) => auth.api.getSession({ headers, returnHeaders: true })))
    .get('/json', (c) => c.json({ userId: c.get('userId') }))
    // A handler answering with a Response of its own, as file downloads do.
    .get('/raw', () => new Response('ok'))
  return { db, auth, app }
}

async function signedIn(auth: ReturnType<typeof setup>['auth']) {
  const response = await auth.handler(
    new Request('http://localhost:3001/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({
        email: 'ada@example.com',
        password: 'correct-horse-battery',
        name: 'Ada',
      }),
    }),
  )
  assert.equal(response.status, 200)
  return response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
}

/** The session as signed in two days ago: due for its daily renewal. */
function twoDaysOld(db: ReturnType<typeof setup>['db']) {
  const session = db.session[0]!
  session.expiresAt = new Date(Date.now() + 5 * DAY)
  session.updatedAt = new Date(Date.now() - 2 * DAY)
  return session
}

const sessionCookie = (response: Response) =>
  response.headers.getSetCookie().find((c) => c.includes('session_token='))

for (const path of ['/json', '/raw']) {
  test(`a session due for renewal renews the browser's cookie too (${path})`, async () => {
    const { db, auth, app } = setup()
    const cookie = await signedIn(auth)
    const session = twoDaysOld(db)

    const response = await app.request(path, { headers: { cookie } })
    assert.equal(response.status, 200)
    // The database's end moved to 7 days from now…
    const expiresAt = (session.expiresAt as Date).valueOf()
    assert.ok(Math.abs(expiresAt - (Date.now() + 7 * DAY)) < 60_000)
    // …and the browser's cookie with it.
    const renewed = sessionCookie(response)
    assert.ok(renewed, 'no renewed session cookie on the response')
    assert.match(renewed, /Max-Age=604800/)
    assert.equal(
      renewed.split(';')[0],
      cookie.split('; ').find((c) => c.includes('session_token=')),
    )
  })
}

test('a fresh session sends no cookie', async () => {
  const { auth, app } = setup()
  const cookie = await signedIn(auth)
  const response = await app.request('/json', { headers: { cookie } })
  assert.equal(response.status, 200)
  assert.equal(sessionCookie(response), undefined)
})

test('without a session, 401', async () => {
  const { app } = setup()
  const response = await app.request('/json')
  assert.equal(response.status, 401)
})

// Sockets read the session with disableRefresh (socketScope in src/app.ts, src/hub-object.ts):
// a refresh there would move the database's end and leave the next HTTP call nothing to renew.
test('a read with disableRefresh leaves the renewal to the next HTTP call', async () => {
  const { db, auth, app } = setup()
  const cookie = await signedIn(auth)
  const session = twoDaysOld(db)
  const before = (session.expiresAt as Date).valueOf()

  const read = await auth.api.getSession({
    headers: new Headers({ cookie }),
    query: { disableRefresh: true },
  })
  assert.ok(read)
  assert.equal((session.expiresAt as Date).valueOf(), before)

  const response = await app.request('/json', { headers: { cookie } })
  assert.ok(sessionCookie(response), 'no renewed session cookie after the socket read')
})
