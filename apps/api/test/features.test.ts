import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'
import { Hono } from 'hono'
import { FEATURES } from '@brigade/contracts'

// Features hidden until ready (src/features.ts, docs/feature-flags.md):
// - a row opens its feature to everyone, to addresses (without case), to domains, to workspaces;
// - without a row, the declared default;
// - for someone without Gmail, GET /connections hides it and POST /connections/google refuses it,
//   and /me lists only the features they have.
// The database part runs against the API's development database (apps/api/.env), skipped when
// none answers; it changes the gmail row and puts it back as it was.
const envFile = new URL('../.env', import.meta.url)
if (!process.env.DATABASE_URL && existsSync(envFile))
  process.env.DATABASE_URL = parseEnv(readFileSync(envFile, 'utf8')).DATABASE_URL
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
process.env.GOOGLE_CLIENT_ID ??= 'test-google-client'
process.env.GOOGLE_CLIENT_SECRET ??= 'test-google-secret'

const { opens, appOpen } = await import('../src/features.js')
const { prisma } = await import('../src/db.js')
const database = await Promise.race([
  prisma.$queryRaw`select 1`.then(() => true),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
]).catch(() => false)

const row = (r: Partial<Parameters<typeof opens>[0]>) => ({
  key: 'gmail',
  everyone: false,
  emails: [],
  workspaceIds: [],
  ...r,
})

test('a row opens its feature to everyone, addresses, domains or workspaces', () => {
  const ada = { email: 'Ada@Acme.test', workspaceId: 'w1' }
  assert.equal(opens(row({}), ada), false)
  assert.equal(opens(row({ everyone: true }), ada), true)
  assert.equal(opens(row({ emails: ['ada@acme.test'] }), ada), true, 'without case')
  assert.equal(opens(row({ emails: [' ADA@acme.test '] }), ada), true)
  assert.equal(opens(row({ emails: ['bob@acme.test'] }), ada), false)
  assert.equal(opens(row({ emails: ['@acme.test'] }), ada), true, 'a whole domain')
  assert.equal(opens(row({ emails: ['@cme.test'] }), ada), false, 'not a part of one')
  assert.equal(opens(row({ emails: ['acme.test'] }), ada), false, 'a domain needs its @')
  assert.equal(opens(row({ emails: ['@sub.acme.test'] }), ada), false)
  assert.equal(opens(row({ workspaceIds: ['w1'] }), ada), true)
  assert.equal(opens(row({ workspaceIds: ['w2'] }), ada), false)
  assert.equal(opens(row({ workspaceIds: ['w1'] }), { ...ada, workspaceId: null }), false)
})

test('Gmail and Drive are hidden by default; other Apps are not behind a feature', () => {
  assert.equal(FEATURES.gmail.default, false)
  assert.equal(FEATURES.google_drive.default, false)
  assert.equal(appOpen('gmail', new Set()), false)
  assert.equal(appOpen('google_drive', new Set()), false)
  assert.equal(appOpen('gmail', new Set(['gmail'])), true)
  for (const kind of ['google_docs', 'google_sheets', 'google_calendar', 'stripe', 'mcp'])
    assert.equal(appOpen(kind, new Set()), true, kind)
})

describe(
  'Gmail for people with and without it',
  { skip: !database && 'no database answers' },
  () => {
    const suffix = randomUUID().slice(0, 8)
    const org = `org-features-${suffix}`
    const ids = {} as Record<'workspace' | 'ada' | 'bob', string>
    let saved: Awaited<ReturnType<typeof prisma.featureFlag.findUnique>> = null
    let app: Hono
    let restore: () => void

    before(async () => {
      saved = await prisma.featureFlag.findUnique({ where: { key: 'gmail' } })
      // Ada's address as someone may have typed it: compared without case.
      await prisma.featureFlag.upsert({
        where: { key: 'gmail' },
        create: { key: 'gmail', emails: [`ADA-${suffix}@open.test`] },
        update: { everyone: false, emails: [`ADA-${suffix}@open.test`], workspaceIds: [] },
      })
      await prisma.organization.create({ data: { id: org, name: 'Features', slug: org } })
      ids.workspace = (
        await prisma.workspace.create({ data: { organizationId: org, name: 'Features' } })
      ).id
      for (const [who, domain] of [
        ['ada', 'open.test'],
        ['bob', 'closed.test'],
      ] as const) {
        ids[who] = `${who}-${suffix}`
        await prisma.user.create({
          data: { id: ids[who], name: who, email: `${who}-${suffix}@${domain}` },
        })
        await prisma.member.create({
          data: { id: `m-${ids[who]}`, organizationId: org, userId: ids[who], role: 'owner' },
        })
      }
      const { auth } = await import('../src/auth.js')
      const { connections } = await import('../src/routes/connections.js')
      const { workspaces } = await import('../src/routes/workspaces.js')
      // Signed in as whoever the x-test-user header names, without a cookie.
      const getSession = auth.api.getSession
      ;(auth.api as { getSession: unknown }).getSession = async ({
        headers,
      }: {
        headers: Headers
      }) => ({
        user: { id: headers.get('x-test-user') },
        session: {
          id: `session-${headers.get('x-test-user')}`,
          activeOrganizationId: org,
          activeWorkspaceId: ids.workspace,
        },
      })
      restore = () => ((auth.api as { getSession: unknown }).getSession = getSession)
      app = new Hono().route('/api', workspaces).route('/api/connections', connections)
    })

    after(async () => {
      restore?.()
      if (saved) {
        const { key: _key, updatedAt: _at, ...rest } = saved
        await prisma.featureFlag.update({ where: { key: 'gmail' }, data: rest })
      } else await prisma.featureFlag.deleteMany({ where: { key: 'gmail' } })
      if (ids.workspace) await prisma.workspace.deleteMany({ where: { id: ids.workspace } })
      await prisma.member.deleteMany({ where: { organizationId: org } })
      await prisma.organization.deleteMany({ where: { id: org } })
      await prisma.user.deleteMany({ where: { id: { in: [ids.ada, ids.bob] } } })
    })

    const get = (who: 'ada' | 'bob', path: string) =>
      app.request(path, { headers: { 'x-test-user': ids[who] } })

    test('/me lists Gmail only for the person it is open to', async () => {
      const ada = await (await get('ada', '/api/me')).json()
      const bob = await (await get('bob', '/api/me')).json()
      assert.ok(ada.features.includes('gmail'))
      assert.ok(!bob.features.includes('gmail'))
    })

    test('GET /connections hides Gmail from Bob and leaves it to Ada', async () => {
      const ada = await (await get('ada', '/api/connections')).json()
      const bob = await (await get('bob', '/api/connections')).json()
      assert.ok(!ada.hidden.includes('gmail'))
      assert.equal(ada.available.gmail, true)
      assert.ok(bob.hidden.includes('gmail'))
      assert.equal(bob.available.gmail, false)
      // Docs is verified by Google: open to both.
      assert.equal(bob.available.google_docs, true)
      assert.ok(!bob.hidden.includes('google_docs'))
    })

    test("POST /connections/google starts Gmail's sign-in for Ada only", async () => {
      const start = (who: 'ada' | 'bob', kind: string) =>
        app.request('/api/connections/google', {
          method: 'POST',
          headers: { 'x-test-user': ids[who], 'content-type': 'application/json' },
          body: JSON.stringify({ kind }),
        })
      const ada = await start('ada', 'gmail')
      assert.equal(ada.status, 200, await ada.clone().text())
      assert.match((await ada.json()).url, /accounts\.google\.com/)
      const bob = await start('bob', 'gmail')
      assert.equal(bob.status, 403)
      assert.match(await bob.text(), /not open to your account/)
      assert.equal((await start('bob', 'google_docs')).status, 200)
    })
  },
)
