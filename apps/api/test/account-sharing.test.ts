import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import pg from 'pg'

// The AI accounts on the cloud computer are the workspace's (src/account-sharing.ts): every
// member's work there runs on them, those on a member's own computer stay theirs. Against the
// local database of apps/api/.env, in an organization of its own removed at the end; skipped
// without a database to reach.
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

async function reachable() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  })
  try {
    await client.connect()
    await client.query('select 1 from "Account" limit 1')
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
const { prisma, scoped } = await import('../src/db.js')
const { accounts, usableAccounts } = await import('../src/routes/accounts.js')
const { workspaces } = await import('../src/routes/workspaces.js')

const run = randomUUID().slice(0, 8)
const org = `org-share-${run}`
const people = ['ada', 'bob', 'cat'] as const
type Person = (typeof people)[number]
const roles: Record<Person, string> = { ada: 'owner', bob: 'member', cat: 'admin' }
const member = (p: Person) => `m-share-${p}-${run}`
const user = (p: Person) => `u-share-${p}-${run}`
let workspaceId: string
let cloud: string
let adaMac: string
const ids: Record<string, string> = {}

// Signed in as whoever `as` names, without a cookie: the session is the test's.
let as: Person = 'ada'
const getSession = auth.api.getSession
const app = new Hono()
app.route('/api', workspaces)
app.route('/api/accounts', accounts)
app.onError((error, c) =>
  error instanceof HTTPException
    ? c.json({ error: error.message }, error.status)
    : c.json({ error: String(error) }, 500),
)
const call = (person: Person, path: string, init: { method?: string; body?: unknown } = {}) => {
  as = person
  return app.request(path, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json' },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  })
}

before(async () => {
  if (skip) return
  await prisma.organization.create({ data: { id: org, name: 'Sharing', slug: org } })
  for (const p of people) {
    await prisma.user.create({ data: { id: user(p), name: p, email: `${user(p)}@example.com` } })
    await prisma.member.create({
      data: { id: member(p), organizationId: org, userId: user(p), role: roles[p] },
    })
  }
  workspaceId = (await prisma.workspace.create({ data: { organizationId: org, name: 'Sharing' } }))
    .id
  const db = scoped({ organizationId: org, workspaceId })
  cloud = (await db.computer.create({ data: { kind: 'cloud', name: 'Cloud computer' } } as never))
    .id
  adaMac = (
    await db.computer.create({
      data: { kind: 'member_machine', memberId: member('ada'), name: 'Ada’s Mac' },
    } as never)
  ).id
  const account = async (key: string, p: Person, computerId: string) =>
    (ids[key] = (
      await db.account.create({
        data: {
          memberId: member(p),
          computerId,
          provider: 'claude_code',
          source: 'machine',
          label: key,
          status: 'ready',
          isDefault: true,
        },
      } as never)
    ).id)
  await account('adaCloud', 'ada', cloud)
  await account('adaMac', 'ada', adaMac)
  ;(auth.api as { getSession: unknown }).getSession = async () => ({
    user: { id: user(as) },
    session: { id: `s-share-${run}`, activeOrganizationId: org, activeWorkspaceId: workspaceId },
  })
})

after(async () => {
  ;(auth.api as { getSession: unknown }).getSession = getSession
  if (skip) return
  await prisma.workspace.deleteMany({ where: { organizationId: org } })
  await prisma.organization.deleteMany({ where: { id: org } })
  await prisma.user.deleteMany({ where: { id: { in: people.map(user) } } })
})

const usable = (p: Person, computerId: string) =>
  usableAccounts(scoped({ organizationId: org, workspaceId }), {
    memberId: member(p),
    computerId,
    provider: 'claude_code',
  }).then((rows) => rows.map((r) => r.label))

test(
  'a member runs on the cloud computer’s accounts, never on another’s own computer',
  { skip },
  async () => {
    assert.deepEqual(await usable('bob', cloud), ['adaCloud'])
    assert.deepEqual(await usable('bob', adaMac), [])
    assert.deepEqual(await usable('ada', adaMac), ['adaMac'])
  },
)

test('a member’s own account on the cloud computer comes first for them', { skip }, async () => {
  const db = scoped({ organizationId: org, workspaceId })
  const bobs = await db.account.create({
    data: {
      memberId: member('bob'),
      computerId: cloud,
      provider: 'claude_code',
      source: 'machine',
      label: 'bobCloud',
      status: 'ready',
      isDefault: true,
    },
  } as never)
  try {
    assert.deepEqual(await usable('bob', cloud), ['bobCloud', 'adaCloud'])
    assert.deepEqual(await usable('ada', cloud), ['adaCloud', 'bobCloud'])
  } finally {
    await db.account.deleteMany({ where: { id: bobs.id } })
  }
})

test('a member who joined is ready to start threads on the shared account', { skip }, async () => {
  const me = (await (await call('bob', '/api/me')).json()) as { aiReady: boolean }
  assert.equal(me.aiReady, true)
})

test(
  'the list says whose each account is; another’s own computer stays hidden',
  { skip },
  async () => {
    const listed = (await (await call('bob', '/api/accounts')).json()) as {
      label: string
      mine: boolean
      shared: boolean
      addedBy: string
    }[]
    assert.deepEqual(
      listed.map((a) => [a.label, a.mine, a.shared, a.addedBy]),
      [['adaCloud', false, true, 'ada']],
    )
    const ada = (await (await call('ada', '/api/accounts')).json()) as { label: string }[]
    assert.deepEqual(ada.map((a) => a.label).sort(), ['adaCloud', 'adaMac'])
  },
)

test('only who added a shared account changes it; an admin may remove it', { skip }, async () => {
  const id = ids.adaCloud!
  assert.equal(
    (await call('bob', `/api/accounts/${id}`, { method: 'PATCH', body: { isDefault: true } }))
      .status,
    403,
  )
  assert.equal((await call('bob', `/api/accounts/${id}/sign-in`, { body: {} })).status, 403)
  assert.equal((await call('bob', `/api/accounts/${id}`, { method: 'DELETE' })).status, 403)
  assert.equal((await call('bob', `/api/accounts/${ids.adaMac}`, { method: 'DELETE' })).status, 404)
  // An admin may: removed (a machine's own login, so nothing to send to the computer).
  assert.equal((await call('cat', `/api/accounts/${id}`, { method: 'DELETE' })).status, 204)
  assert.equal(await prisma.account.count({ where: { id } }), 0)
  const me = (await (await call('bob', '/api/me')).json()) as { aiReady: boolean }
  assert.equal(me.aiReady, false)
})
