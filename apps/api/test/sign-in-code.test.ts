import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'
import pg from 'pg'

// Signing in with a code mailed to the address (src/sign-in-code.ts, src/auth.ts), on the real
// auth against the local database of apps/api/.env: no sign-up with a password, a code that signs up a new
// address as verified, and the rate limit per visitor. Without Resend, the code is logged,
// which is where the test reads it. Without a database to reach, skipped.
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
delete process.env.TURNSTILE_SECRET_KEY

async function reachable() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  })
  try {
    await client.connect()
    await client.query('select "id" from "RateLimit" limit 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}
const skip = (await reachable()) ? false : 'no database to reach (apps/api/.env DATABASE_URL)'

const { auth } = await import('../src/auth.js')
const { prisma } = await import('../src/db.js')
const { signInCodeMail } = await import('../src/sign-in-code.js')
const { env } = await import('../src/config.js')

const run = randomUUID().slice(0, 8)
const emails: string[] = []
const address = (name: string) => {
  const email = `${name}-${run}@example.com`
  emails.push(email)
  return email
}
// A visitor of its own per test: TEST-NET addresses, never a real one.
let visitors = 0
const visitor = () => `198.51.100.${++visitors}`

function call(path: string, body: unknown, ip?: string) {
  return auth.handler(
    new Request(`${env.API_URL}/api/auth${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: env.WEB_URL[0]!,
        ...(ip ? { 'cf-connecting-ip': ip } : {}),
      },
      body: JSON.stringify(body),
    }),
  )
}

/** Mails a code and returns it, read from the log (no Resend here). */
async function codeFor(email: string, ip?: string) {
  const logged: string[] = []
  const log = console.log
  console.log = (...args: unknown[]) => void logged.push(args.join(' '))
  try {
    const response = await call('/email-otp/send-verification-otp', { email, type: 'sign-in' }, ip)
    assert.equal(response.status, 200, await response.clone().text())
  } finally {
    console.log = log
  }
  const line = logged.find((l) => l.startsWith(`sign-in code for ${email}: `))
  assert.ok(line, 'the code is logged')
  return line.split(': ')[1]!
}

after(async () => {
  await prisma.user.deleteMany({ where: { email: { in: emails } } })
  await prisma.verification.deleteMany({ where: { identifier: { contains: run } } })
  await prisma.rateLimit.deleteMany({ where: { key: { startsWith: '198.51.100.' } } })
  await prisma.$disconnect()
})

test('the mail carries the code, in its subject too', () => {
  const mail = signInCodeMail('ada@example.com', '123456')
  assert.deepEqual(mail.to, ['ada@example.com'])
  assert.match(mail.subject, /123456/)
  assert.match(mail.text, /123456/)
})

test('no account is made with a password', { skip }, async () => {
  const email = address('password')
  const response = await call(
    '/sign-up/email',
    { email, password: 'correct-horse-battery', name: 'Mallory' },
    visitor(),
  )
  assert.notEqual(response.status, 200)
  assert.equal(await prisma.user.count({ where: { email } }), 0)
})

test('only an account given a password signs in with one', { skip }, async () => {
  const ip = visitor()
  const tester = address('tester')
  const ctx = await auth.$context
  const user = await ctx.internalAdapter.createUser({
    email: tester,
    name: 'Tester',
    emailVerified: true,
  })
  await ctx.internalAdapter.linkAccount({
    userId: user.id,
    providerId: 'credential',
    accountId: user.id,
    password: await ctx.password.hash('correct-horse-battery'),
  })
  const member = address('member')
  const otp = await codeFor(member, ip)
  assert.equal((await call('/sign-in/email-otp', { email: member, otp }, ip)).status, 200)

  const asks = async (email: string) => {
    const response = await auth.handler(
      new Request(
        `${env.API_URL}/api/auth/password-sign-in?${new URLSearchParams({ email: email.toUpperCase() })}`,
        { headers: { origin: env.WEB_URL[0]! } },
      ),
    )
    assert.equal(response.status, 200)
    return ((await response.json()) as { password: boolean }).password
  }
  assert.equal(await asks(tester), true)
  assert.equal(await asks(member), false)
  assert.equal(await asks(address('nobody')), false)

  const signedIn = await call(
    '/sign-in/email',
    { email: tester, password: 'correct-horse-battery' },
    visitor(),
  )
  assert.equal(signedIn.status, 200, await signedIn.clone().text())
  const wrong = await call(
    '/sign-in/email',
    { email: tester, password: 'wrong-horse-battery' },
    visitor(),
  )
  assert.notEqual(wrong.status, 200)
  const noPassword = await call(
    '/sign-in/email',
    { email: member, password: 'correct-horse-battery' },
    visitor(),
  )
  assert.notEqual(noPassword.status, 200)
})

test('a code signs up a new address, verified, with its name', { skip }, async () => {
  const email = address('new')
  const ip = visitor()
  const code = await codeFor(email, ip)
  assert.match(code, /^\d{6}$/)

  const wrong = await call('/sign-in/email-otp', { email, otp: '000000', name: 'Ada' }, ip)
  assert.notEqual(wrong.status, 200)

  const response = await call('/sign-in/email-otp', { email, otp: code, name: 'Ada' }, ip)
  assert.equal(response.status, 200, await response.clone().text())
  assert.match(response.headers.get('set-cookie') ?? '', /session_token=/)
  const user = await prisma.user.findUniqueOrThrow({ where: { email } })
  assert.equal(user.emailVerified, true)
  assert.equal(user.name, 'Ada')

  // Used once.
  const again = await call('/sign-in/email-otp', { email, otp: code }, ip)
  assert.notEqual(again.status, 200)
})

test('a visitor gets 3 codes a minute, another visitor is counted apart', { skip }, async () => {
  const email = address('limit')
  const ip = visitor()
  for (let i = 0; i < 3; i++) await codeFor(email, ip)
  const fourth = await call('/email-otp/send-verification-otp', { email, type: 'sign-in' }, ip)
  assert.equal(fourth.status, 429)
  await codeFor(email, visitor())
})

test('a client-sent X-Forwarded-For does not pick the visitor', { skip }, async () => {
  const email = address('forwarded')
  const ip = visitor()
  for (let i = 0; i < 3; i++) await codeFor(email, ip)
  const response = await auth.handler(
    new Request(`${env.API_URL}/api/auth/email-otp/send-verification-otp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: env.WEB_URL[0]!,
        'cf-connecting-ip': ip,
        'x-forwarded-for': '203.0.113.9',
      },
      body: JSON.stringify({ email, type: 'sign-in' }),
    }),
  )
  assert.equal(response.status, 429)
})
