import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import pg from 'pg'

// Guests (src/guests.ts, docs/guests.md): Brigade.app's window starts without a sign-in, as a
// guest who can make a project and run teammates, but not invite anyone or buy Brigade Cloud,
// until they save the account with an email and its code. Unsaved and unused, they are swept.
// Against the local database of apps/api/.env; without one to reach, the tests are skipped.
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
process.env.RESEND_API_KEY = ''
// Billing on, with a key that reaches nothing: a guest is refused before Stripe is called.
process.env.STRIPE_SECRET_KEY = 'sk_test_never_called'
delete process.env.TURNSTILE_SECRET_KEY

async function reachable() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  })
  try {
    await client.connect()
    await client.query('select "guest" from "User" limit 1')
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
const { members } = await import('../src/routes/members.js')
const { workspaces } = await import('../src/routes/workspaces.js')
const { billing } = await import('../src/routes/billing.js')
const guests = await import('../src/guests.js')
const { deleteAccount } = await import('../src/account-delete.js')

const app = new Hono()
app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))
app.route('/api', workspaces)
app.route('/api', members)
app.route('/api/billing', billing)
app.onError((error, c) =>
  error instanceof HTTPException
    ? c.json({ error: error.message }, error.status)
    : c.json({ error: String(error) }, 500),
)

const run = randomUUID().slice(0, 8)
const users: string[] = []
const emails: string[] = []
let flagBefore: { everyone: boolean } | null = null

function call(path: string, init: { method?: string; body?: unknown; cookie?: string } = {}) {
  return app.request(`${env.API_URL}${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: {
      'content-type': 'application/json',
      origin: env.WEB_URL[0]!,
      ...(init.cookie && { cookie: init.cookie }),
    },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  })
}

const cookieOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')

/** What the API logs while `fn` runs (no Resend here: codes are logged). */
async function logged(fn: () => Promise<unknown>) {
  const lines: string[] = []
  const log = console.log
  console.log = (...args: unknown[]) => void lines.push(args.join(' '))
  try {
    await fn()
  } finally {
    console.log = log
  }
  return lines
}

const setFlag = (everyone: boolean) =>
  prisma.featureFlag.upsert({
    where: { key: 'guest_mode' },
    create: { key: 'guest_mode', everyone, note: 'guests.test.ts' },
    update: { everyone },
  })

/** A guest, as Brigade.app's sign-in page makes one, with their first project. */
async function newGuest() {
  const started = await call('/api/auth/guest', { body: {} })
  assert.equal(started.status, 200, await started.clone().text())
  const cookie = cookieOf(started)
  const session = await call('/api/auth/get-session', { cookie })
  const { user } = (await session.json()) as { user: { id: string; email: string } }
  users.push(user.id)
  const created = await call('/api/auth/organization/create', {
    body: { name: 'My project', slug: `my-project-${run}-${users.length}` },
    cookie,
  })
  assert.equal(created.status, 200, await created.clone().text())
  assert.equal((await call('/api/me', { cookie })).status, 200)
  const workspace = await call('/api/workspaces', { body: { name: 'My project' }, cookie })
  assert.equal(workspace.status, 201, await workspace.clone().text())
  const { id: workspaceId } = (await workspace.json()) as { id: string }
  return { cookie, userId: user.id, email: user.email, workspaceId }
}

/** The code a guest's saving mails to `email`, sent and read from the log. */
async function savingCode(cookie: string, email: string) {
  let response!: Response
  const lines = await logged(async () => {
    response = await call('/api/auth/guest/save/code', { body: { email }, cookie })
  })
  assert.equal(response.status, 200, await response.clone().text())
  const code = lines.find((l) => l.startsWith(`sign-in code for ${email}: `))?.split(': ')[1]
  assert.ok(code, 'the code is logged')
  return code
}

before(async () => {
  if (skip) return
  flagBefore = await prisma.featureFlag.findUnique({ where: { key: 'guest_mode' } })
  await setFlag(true)
})

after(async () => {
  if (skip) return
  for (const id of users) await deleteAccount(id).catch(() => {})
  const organizations = await prisma.member.findMany({
    where: { userId: { in: users } },
    select: { organizationId: true },
  })
  const ids = organizations.map((m) => m.organizationId)
  await prisma.workspace.deleteMany({ where: { organizationId: { in: ids } } })
  await prisma.organization.deleteMany({ where: { id: { in: ids } } })
  await prisma.user.deleteMany({
    where: { OR: [{ id: { in: users } }, { email: { in: emails } }] },
  })
  if (flagBefore) await setFlag(flagBefore.everyone)
  else await prisma.featureFlag.deleteMany({ where: { key: 'guest_mode' } })
  await prisma.$disconnect()
})

test('closed, nobody starts as a guest', { skip }, async () => {
  await setFlag(false)
  try {
    const available = await call('/api/auth/guest/available')
    assert.deepEqual(await available.json(), { available: false })
    const started = await call('/api/auth/guest', { body: {} })
    assert.equal(started.status, 404)
    assert.equal(started.headers.getSetCookie().length, 0)
  } finally {
    await setFlag(true)
  }
})

test('a guest is signed in, makes a project and is told apart', { skip }, async () => {
  const available = await call('/api/auth/guest/available')
  assert.deepEqual(await available.json(), { available: true })
  const guest = await newGuest()
  assert.ok(guests.isGuestEmail(guest.email))
  const me = (await (await call('/api/me', { cookie: guest.cookie })).json()) as {
    guest: boolean
    role: string
    activeWorkspaceId: string
  }
  assert.equal(me.guest, true)
  assert.equal(me.role, 'owner')
  assert.equal(me.activeWorkspaceId, guest.workspaceId)
  // Their session outlasts better-auth's week: signed out, a guest could not come back.
  const session = await prisma.authSession.findFirstOrThrow({ where: { userId: guest.userId } })
  assert.ok(session.expiresAt.getTime() > Date.now() + 300 * 24 * 60 * 60_000)
  const user = await prisma.user.findUniqueOrThrow({ where: { id: guest.userId } })
  assert.equal(user.guest, true)
  assert.equal((user.attribution as { method?: string } | null)?.method, 'guest')
})

test('a guest cannot invite anyone or buy Brigade Cloud', { skip }, async () => {
  const guest = await newGuest()
  const invited = await call('/api/members/invitations', {
    body: { email: `someone-${run}@example.com`, role: 'member' },
    cookie: guest.cookie,
  })
  assert.equal(invited.status, 403)
  assert.match(((await invited.json()) as { error: string }).error, /Save your account/)
  const checkout = await call('/api/billing/checkout', {
    body: { from: 'onboarding' },
    cookie: guest.cookie,
  })
  assert.equal(checkout.status, 403)
})

test('a guest saves the account with their email and its code', { skip }, async () => {
  const guest = await newGuest()
  const email = `saved-${run}@example.com`
  emails.push(email)
  const code = await savingCode(guest.cookie, email)
  const wrong = await call('/api/auth/guest/save', {
    body: { email, code: code === '000000' ? '111111' : '000000' },
    cookie: guest.cookie,
  })
  assert.equal(wrong.status, 400)
  const saved = await call('/api/auth/guest/save', { body: { email, code }, cookie: guest.cookie })
  assert.equal(saved.status, 200, await saved.clone().text())
  const user = await prisma.user.findUniqueOrThrow({ where: { id: guest.userId } })
  assert.equal(user.guest, false)
  assert.equal(user.email, email)
  assert.equal(user.emailVerified, true)
  // The same session goes on, now an account's: what waited for it opens.
  const me = (await (await call('/api/me', { cookie: guest.cookie })).json()) as { guest: boolean }
  assert.equal(me.guest, false)
  await guests.requireSavedAccount(guest.userId, 'inviting someone')
  // The code is used up.
  const again = await call('/api/auth/guest/save', { body: { email, code }, cookie: guest.cookie })
  assert.equal(again.status, 400)
})

test('a code wrong five times is used up', { skip }, async () => {
  const guest = await newGuest()
  const email = `tries-${run}@example.com`
  const code = await savingCode(guest.cookie, email)
  const other = code === '000000' ? '111111' : '000000'
  for (let i = 0; i < 5; i++) {
    const wrong = await call('/api/auth/guest/save', {
      body: { email, code: other },
      cookie: guest.cookie,
    })
    assert.equal(wrong.status, 400)
  }
  const right = await call('/api/auth/guest/save', { body: { email, code }, cookie: guest.cookie })
  assert.equal(right.status, 400)
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: guest.userId } })).guest, true)
})

test('an address with an account already is refused', { skip }, async () => {
  const taken = `taken-${run}@example.com`
  emails.push(taken)
  await prisma.user.create({ data: { id: `user-taken-${run}`, name: '', email: taken } })
  const guest = await newGuest()
  const sent = await call('/api/auth/guest/save/code', {
    body: { email: taken },
    cookie: guest.cookie,
  })
  assert.equal(sent.status, 409)
})

test('a guest mails a few saving codes at most', { skip }, async () => {
  const guest = await newGuest()
  const email = `codes-${run}@example.com`
  for (let i = 0; i < 5; i++) await savingCode(guest.cookie, email)
  const sixth = await call('/api/auth/guest/save/code', { body: { email }, cookie: guest.cookie })
  assert.equal(sixth.status, 429)
})

test('a guest unused for two weeks is swept with their project', { skip }, async () => {
  const idle = await newGuest()
  const active = await newGuest()
  const later = new Date(Date.now() + (guests.GUEST_IDLE_DAYS + 1) * 24 * 60 * 60_000)
  // The active one's thread moved since: they stay.
  const teammate = await prisma.teammate.findFirstOrThrow({
    where: { workspaceId: active.workspaceId },
  })
  const member = await prisma.member.findFirstOrThrow({ where: { userId: active.userId } })
  const computer = await prisma.computer.create({
    data: {
      organizationId: member.organizationId,
      workspaceId: active.workspaceId,
      kind: 'member_machine',
      name: 'Mac',
      memberId: member.id,
    },
  })
  await prisma.runner.create({
    data: {
      organizationId: member.organizationId,
      workspaceId: active.workspaceId,
      computerId: computer.id,
      tokenHash: `guests-test-${run}`,
      lastSeenAt: later,
    },
  })
  assert.ok(teammate)
  const deleted = await guests.sweepIdleGuests(new Date(later.getTime() + 60_000), 1000)
  assert.ok(deleted.includes(idle.userId))
  assert.ok(!deleted.includes(active.userId))
  assert.equal(await prisma.user.count({ where: { id: idle.userId } }), 0)
  assert.equal(await prisma.workspace.count({ where: { id: idle.workspaceId } }), 0)
  assert.equal(await prisma.workspace.count({ where: { id: active.workspaceId } }), 1)
})

test('a guest project full of work waits for the account to be saved', { skip }, async () => {
  const guest = await newGuest()
  await guests.requireGuestRoom(guest.userId, guest.workspaceId)
  const member = await prisma.member.findFirstOrThrow({ where: { userId: guest.userId } })
  await prisma.workspaceEventDay.create({
    data: {
      organizationId: member.organizationId,
      workspaceId: guest.workspaceId,
      day: new Date('2026-11-17'),
      events: 1,
      deltas: 0,
      bytes: BigInt(guests.GUEST_STORAGE_BYTES),
      largest: 1,
    },
  })
  await assert.rejects(guests.requireGuestRoom(guest.userId, guest.workspaceId), (e: unknown) => {
    assert.ok(e instanceof HTTPException)
    assert.equal(e.status, 402)
    return true
  })
  await prisma.user.update({ where: { id: guest.userId }, data: { guest: false } })
  await guests.requireGuestRoom(guest.userId, guest.workspaceId)
})
