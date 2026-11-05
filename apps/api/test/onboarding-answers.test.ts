import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, afterEach, test } from 'node:test'
import pg from 'pg'

// Onboarding's questions (POST /me/onboarding, src/routes/workspaces.ts): the answers are kept
// once on the user and read back in /me, only answers of the closed lists are taken, and
// `onboarding_answered` goes to PostHog (a stub of fetch here) with the answers as the
// person's properties. On the real auth against apps/api/.env's database; skipped without one.
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
process.env.PASSWORD_SIGN_IN = 'false'
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
    await client.query('select "onboardingAnswers" from "User" limit 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}
const skip = (await reachable()) ? false : 'no database to reach (apps/api/.env DATABASE_URL)'

const { Hono } = await import('hono')
const { HTTPException } = await import('hono/http-exception')
const { auth } = await import('../src/auth.js')
const { prisma } = await import('../src/db.js')
const { env } = await import('../src/config.js')
const { workspaces } = await import('../src/routes/workspaces.js')
const analytics = await import('../src/analytics.js')

const app = new Hono()
app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))
app.route('/api', workspaces)
app.onError((error, c) =>
  error instanceof HTTPException
    ? c.json({ error: error.message }, error.status)
    : c.json({ error: String(error) }, 500),
)

type Batch = { batch: { event: string; distinct_id: string; properties: Record<string, any> }[] }
const sent: Batch[] = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input)
  if (!url.includes('posthog')) return realFetch(input, init)
  sent.push(JSON.parse(String(init?.body)))
  return new Response('{}', { status: 200 })
}) as typeof fetch
const events = () => sent.flatMap((s) => s.batch)
afterEach(async () => {
  await analytics.flushAnalytics()
  env.POSTHOG_KEY = undefined
  sent.length = 0
})

const run = randomUUID().slice(0, 8)
const emails: string[] = []
after(async () => {
  if (skip) return
  await prisma.user.deleteMany({ where: { email: { in: emails } } })
})

function call(path: string, init: { body?: unknown; cookie?: string } = {}) {
  return app.request(`${env.API_URL}${path}`, {
    method: init.body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      origin: env.WEB_URL[0]!,
      ...(init.cookie && { cookie: init.cookie }),
    },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  })
}

async function signIn(name: string) {
  const email = `${name}-${run}@example.com`
  emails.push(email)
  const lines: string[] = []
  const log = console.log
  console.log = (...args: unknown[]) => void lines.push(args.join(' '))
  try {
    await call('/api/auth/email-otp/send-verification-otp', { body: { email, type: 'sign-in' } })
  } finally {
    console.log = log
  }
  const otp = lines.find((l) => l.startsWith(`sign-in code for ${email}: `))?.split(': ')[1]
  assert.ok(otp, 'the code is logged')
  const response = await call('/api/auth/sign-in/email-otp', { body: { email, otp } })
  assert.equal(response.status, 200, await response.clone().text())
  const cookie = response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
  const me = (await (await call('/api/me', { cookie })).json()) as { user: { id: string } }
  return { cookie, userId: me.user.id }
}

const answersOf = async (cookie: string) =>
  ((await (await call('/api/me', { cookie })).json()) as { onboardingAnswers: unknown })
    .onboardingAnswers

test('the answers are kept once and read back in /me', { skip }, async () => {
  const { cookie } = await signIn('ada')
  assert.equal(await answersOf(cookie), null, 'never asked')
  const answers = {
    role: { id: 'founder', position: 4 },
    teamSize: { id: '2-10', position: 2 },
    heardFrom: { id: 'hacker_news', position: 1 },
  }
  assert.equal((await call('/api/me/onboarding', { cookie, body: answers })).status, 204)
  assert.deepEqual(await answersOf(cookie), answers)
  // A second send (another tab, a retry) changes nothing.
  const again = await call('/api/me/onboarding', {
    cookie,
    body: { role: { id: 'developer', position: 1 } },
  })
  assert.equal(again.status, 204)
  assert.deepEqual(await answersOf(cookie), answers)
})

test('all skipped is kept as {}, and an answer off the lists is refused', { skip }, async () => {
  const { cookie } = await signIn('bob')
  const refused = await call('/api/me/onboarding', {
    cookie,
    body: { role: { id: 'astronaut', position: 1 } },
  })
  assert.equal(refused.status, 400)
  assert.equal(await answersOf(cookie), null)
  assert.equal((await call('/api/me/onboarding', { cookie, body: {} })).status, 204)
  assert.deepEqual(await answersOf(cookie), {})
})

test('onboarding_answered: positions on the event, answers on the person', { skip }, async () => {
  const { cookie, userId } = await signIn('carol')
  env.POSTHOG_KEY = 'phc_test_key'
  await call('/api/me/onboarding', {
    cookie,
    body: { role: { id: 'agency', position: 7 }, firstWork: { id: 'marketing', position: 3 } },
  })
  // And once only.
  await call('/api/me/onboarding', { cookie, body: {} })
  await analytics.flushAnalytics()
  const answered = events().filter((e) => e.event === 'onboarding_answered')
  assert.equal(answered.length, 1)
  const { properties, distinct_id } = answered[0]!
  assert.equal(distinct_id, userId)
  assert.equal(properties.feature, 'onboarding')
  assert.equal(properties.count, 2)
  assert.equal(properties.role_position, 7)
  assert.equal(properties.first_work_position, 3)
  assert.equal(properties.team_size_position, undefined)
  assert.deepEqual(properties.$set, { role: 'agency', first_work: 'marketing' })
})
