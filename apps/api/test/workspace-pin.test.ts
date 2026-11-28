import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'

// An installed app's window (docs/apps.md, Installed apps) makes its calls in the workspace its
// app came from, with WORKSPACE_PIN_HEADER, whatever workspace the session shows, and two such
// windows of two workspaces stay apart (src/scope.ts). A workspace of an organization the person
// is not in is refused, never taken for the session's. Against the API's development database
// (apps/api/.env), in organizations of its own removed at the end; skipped when none answers.
const envFile = new URL('../.env', import.meta.url)
if (!process.env.DATABASE_URL && existsSync(envFile))
  process.env.DATABASE_URL = parseEnv(readFileSync(envFile, 'utf8')).DATABASE_URL || undefined
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')

const { prisma } = await import('../src/db.js')
const database = await Promise.race([
  prisma.$queryRaw`select 1`.then(() => true),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
]).catch(() => false)

const { Hono } = await import('hono')
const { HTTPException } = await import('hono/http-exception')
const { requireWorkspace, userFrom, WORKSPACE_PIN_HEADER } = await import('../src/scope.js')

const run = randomUUID().slice(0, 8)
const orgA = `org-pin-a-${run}`
const orgB = `org-pin-b-${run}`
const orgC = `org-pin-c-${run}`
const userId = `u-pin-${run}`

describe('a pinned workspace', { skip: !database && 'no database answers' }, () => {
  let a1 = ''
  let a2 = ''
  let b1 = ''
  let c1 = ''
  // The session shows workspace a1, as if the dashboard window had switched to it.
  let active = { org: orgA, workspace: '' }
  const read = async () => ({
    headers: new Headers(),
    response: {
      user: { id: userId },
      session: {
        id: `s-${run}`,
        activeOrganizationId: active.org,
        activeWorkspaceId: active.workspace,
      },
    },
  })
  const app = new Hono()
    .use(userFrom(read))
    .use(requireWorkspace)
    .get('/scope', (c) => c.json(c.var.scope))
  app.onError((error, c) =>
    error instanceof HTTPException
      ? c.json({ error: error.message }, error.status)
      : c.json({ error: String(error) }, 500),
  )
  const scopeFor = async (pin?: string) => {
    const response = await app.request('/scope', {
      headers: pin === undefined ? {} : { [WORKSPACE_PIN_HEADER]: pin },
    })
    return { status: response.status, body: (await response.json()) as Record<string, string> }
  }

  before(async () => {
    await prisma.user.create({ data: { id: userId, name: 'Ada', email: `${userId}@example.com` } })
    for (const org of [orgA, orgB, orgC])
      await prisma.organization.create({ data: { id: org, name: org, slug: org } })
    // A member of A (admin) and B (viewer); not of C.
    await prisma.member.create({
      data: { id: `m-pin-a-${run}`, organizationId: orgA, userId, role: 'admin' },
    })
    await prisma.member.create({
      data: { id: `m-pin-b-${run}`, organizationId: orgB, userId, role: 'viewer' },
    })
    const ws = (organizationId: string, name: string) =>
      prisma.workspace.create({ data: { organizationId, name } }).then((w) => w.id)
    a1 = await ws(orgA, 'A one')
    a2 = await ws(orgA, 'A two')
    b1 = await ws(orgB, 'B one')
    c1 = await ws(orgC, 'C one')
    active = { org: orgA, workspace: a1 }
  })

  after(async () => {
    await prisma.workspace.deleteMany({ where: { organizationId: { in: [orgA, orgB, orgC] } } })
    await prisma.member.deleteMany({ where: { userId } })
    await prisma.organization.deleteMany({ where: { id: { in: [orgA, orgB, orgC] } } })
    await prisma.user.deleteMany({ where: { id: userId } })
  })

  test('without the header, the session’s workspace', async () => {
    const { status, body } = await scopeFor()
    assert.equal(status, 200)
    assert.equal(body.workspaceId, a1)
  })

  test('another workspace of the same organization, by the header', async () => {
    const { body } = await scopeFor(a2)
    assert.equal(body.workspaceId, a2)
    assert.equal(body.organizationId, orgA)
  })

  test('a workspace of another organization the person is in, with their role there', async () => {
    const { status, body } = await scopeFor(b1)
    assert.equal(status, 200)
    assert.equal(body.workspaceId, b1)
    assert.equal(body.organizationId, orgB)
    assert.equal(body.role, 'viewer')
  })

  test('two windows of two workspaces stay apart while the session switches', async () => {
    const [one, two] = await Promise.all([scopeFor(a1), scopeFor(b1)])
    active = { org: orgB, workspace: b1 }
    const [three, four] = await Promise.all([scopeFor(a1), scopeFor(b1)])
    active = { org: orgA, workspace: a1 }
    assert.deepEqual(
      [one, two, three, four].map((r) => r.body.workspaceId),
      [a1, b1, a1, b1],
    )
  })

  test('a workspace the person is not a member of is refused, not replaced', async () => {
    for (const pin of [c1, 'nope', '', '../x']) {
      const { status } = await scopeFor(pin)
      assert.equal(status, 403, `pin ${JSON.stringify(pin)}`)
    }
  })

  test('a member being removed is shut out of a pinned workspace too', async () => {
    await prisma.member.update({
      where: { id: `m-pin-b-${run}` },
      data: { removingAt: new Date() },
    })
    const { status } = await scopeFor(b1)
    assert.equal(status, 403)
  })
})
