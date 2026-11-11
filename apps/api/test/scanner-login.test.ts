import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'
import pg from 'pg'

// The CASA scanner's temporary login aliases (src/scanner-login.ts): its form or JSON body signs
// in an account with a password through better-auth's own endpoint, and sets the session
// cookie; a wrong password or a missing field does not. On the real auth against
// apps/api/.env's database; skipped without one.
const fromEnvFile = () => {
  try {
    const line = readFileSync(new URL('../.env', import.meta.url), 'utf8')
      .split('\n')
      .find((l) => l.startsWith('DATABASE_URL='))
    return line?.slice('DATABASE_URL='.length).replace(/^"|"$/g, '') || undefined
  } catch {
    return undefined
  }
}
process.env.DATABASE_URL ??= fromEnvFile() ?? 'postgresql://test@localhost/test'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
process.env.PASSWORD_SIGN_IN = 'true'
process.env.RESEND_API_KEY = ''
process.env.POSTHOG_KEY = ''
delete process.env.TURNSTILE_SECRET_KEY

async function reachable() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  })
  try {
    await client.connect()
    await client.query('select 1 from "User" limit 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}
const skip = (await reachable()) ? false : 'no database to reach (apps/api/.env DATABASE_URL)'

const { Hono } = await import('hono')
const { auth } = await import('../src/auth.js')
const { prisma } = await import('../src/db.js')
const { env } = await import('../src/config.js')
const { scannerLogin } = await import('../src/scanner-login.js')
const { requireUser } = await import('../src/scope.js')

const app = new Hono()
for (const path of ['/api/auth/login', '/api/v1/auth/login', '/auth/login'])
  app.post(path, scannerLogin(auth))
app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))
app.get('/api/me', requireUser, (c) => c.json({ userId: c.get('userId') }))
app.onError((error, c) =>
  'status' in error && error.status === 401
    ? c.json({ error: error.message }, 401)
    : c.json({ error: String(error) }, 500),
)

const email = `scanner-${randomUUID().slice(0, 8)}@example.com`
const password = `pw-${randomUUID()}`
after(async () => {
  if (!skip) await prisma.user.deleteMany({ where: { email } })
})

const origin = () => env.WEB_URL[0]!
const post = (path: string, body: string, type: string, headers: Record<string, string> = {}) =>
  app.request(`${env.API_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': type, origin: origin(), ...headers },
    body,
  })
const json = (path: string, body: unknown) => post(path, JSON.stringify(body), 'application/json')
const sessionCookie = (response: Response) =>
  response.headers.getSetCookie().find((c) => c.includes('session_token='))

test('the aliases sign in an account with a password, by JSON or form', { skip }, async () => {
  const made = await json('/api/auth/sign-up/email', { email, password, name: 'Scanner' })
  assert.equal(made.status, 200, await made.clone().text())

  for (const path of ['/api/auth/login', '/api/v1/auth/login', '/auth/login']) {
    const response = await json(path, { email, password })
    assert.equal(response.status, 200, path)
    assert.ok(sessionCookie(response), `${path} sets the session cookie`)
  }
  const form = await post(
    '/api/v1/auth/login',
    new URLSearchParams({ username: email, password }).toString(),
    'application/x-www-form-urlencoded',
  )
  assert.equal(form.status, 200)
  assert.ok(sessionCookie(form))
  const session = await app.request(`${env.API_URL}/api/auth/get-session`, {
    headers: { cookie: sessionCookie(form)!.split(';')[0]!, origin: origin() },
  })
  assert.equal(((await session.json()) as { user: { email: string } }).user.email, email)
})

test('a wrong password or a missing field signs nobody in', { skip }, async () => {
  const wrong = await json('/api/auth/login', { email, password: 'not-it' })
  assert.equal(wrong.status, 401)
  assert.equal(sessionCookie(wrong), undefined)
  const missing = await json('/api/auth/login', { email })
  assert.equal(missing.status, 400)
  assert.equal(sessionCookie(missing), undefined)
})

test(
  'the token sign-in returns works as a bearer token, and nothing else does',
  { skip },
  async () => {
    const response = await json('/api/v1/auth/login', { email, password })
    const { token } = (await response.json()) as { token: string }
    assert.ok(token)
    const me = (authorization?: string) =>
      app.request(`${env.API_URL}/api/me`, {
        headers: { ...(authorization && { authorization }), origin: origin() },
      })
    const signedIn = await me(`Bearer ${token}`)
    assert.equal(signedIn.status, 200)
    assert.ok(((await signedIn.json()) as { userId: string }).userId)
    assert.equal((await me()).status, 401)
    assert.equal((await me(`Bearer ${token}x`)).status, 401)
    assert.equal((await me('Bearer not-a-token')).status, 401)
  },
)
