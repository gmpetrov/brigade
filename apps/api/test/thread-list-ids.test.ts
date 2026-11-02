import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'
import { Hono } from 'hono'

// GET /api/threads?id=…, repeated: threads as the sidebar's list has them, by id, however old.
// The sidebar asks for the one open and for those waiting on the member that are older than
// the latest it loaded, so they show with the others waiting. A child thread brings its parent.
// Against the API's development database (apps/api/.env), in an organization of its own
// removed at the end; skipped when no database answers.
const envFile = new URL('../.env', import.meta.url)
if (!process.env.DATABASE_URL && existsSync(envFile))
  process.env.DATABASE_URL = parseEnv(readFileSync(envFile, 'utf8')).DATABASE_URL || undefined
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')

const { prisma, scoped } = await import('../src/db.js')
const database = await Promise.race([
  prisma.$queryRaw`select 1`.then(() => true),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
]).catch(() => false)

describe('threads by id', { skip: !database && 'no database answers' }, () => {
  const suffix = randomUUID().slice(0, 8)
  const ids = {} as Record<'org' | 'user' | 'member' | 'workspace' | 'computer' | 'riley', string>
  let db: ReturnType<typeof scoped>
  let app: Hono
  let restore: () => void

  before(async () => {
    const { auth } = await import('../src/auth.js')
    const { threads } = await import('../src/routes/threads.js')
    ids.org = `org-ids-${suffix}`
    ids.user = `user-ids-${suffix}`
    ids.member = `m-ids-${suffix}`
    await prisma.organization.create({ data: { id: ids.org, name: 'Ids', slug: `ids-${suffix}` } })
    await prisma.user.create({
      data: { id: ids.user, name: 'Ada', email: `${ids.user}@test.local` },
    })
    await prisma.member.create({
      data: { id: ids.member, organizationId: ids.org, userId: ids.user, role: 'owner' },
    })
    ids.workspace = (
      await prisma.workspace.create({ data: { organizationId: ids.org, name: 'Ids' } })
    ).id
    db = scoped({ organizationId: ids.org, workspaceId: ids.workspace })
    ids.computer = (
      await db.computer.create({
        data: { kind: 'member_machine', memberId: ids.member, name: 'Laptop', status: 'running' },
      } as never)
    ).id
    ids.riley = (await db.teammate.create({ data: { name: `Riley ${suffix}` } } as never)).id
    // Signed in as Ada, without a cookie: the session is the test's.
    const getSession = auth.api.getSession
    ;(auth.api as { getSession: unknown }).getSession = async () => ({
      user: { id: ids.user },
      session: {
        id: `session-${suffix}`,
        activeOrganizationId: ids.org,
        activeWorkspaceId: ids.workspace,
      },
    })
    restore = () => ((auth.api as { getSession: unknown }).getSession = getSession)
    app = new Hono().route('/api/threads', threads)
  })

  after(async () => {
    restore?.()
    if (ids.workspace) await prisma.workspace.deleteMany({ where: { id: ids.workspace } })
    await prisma.member.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.deleteMany({ where: { id: ids.org } })
    await prisma.user.deleteMany({ where: { id: ids.user } })
  })

  const thread = (title: string, parentId?: string) =>
    db.session.create({
      data: {
        teammateId: ids.riley,
        startedByMemberId: ids.member,
        computerId: ids.computer,
        title,
        status: 'idle',
        ...(parentId ? { parentId, parentTeammateId: ids.riley, origin: 'child' } : {}),
      },
    } as never)

  const list = async (query: string) => {
    const res = await app.request(`/api/threads?${query}`)
    assert.equal(res.status, 200, await res.clone().text())
    return ((await res.json()) as { id: string; title: string }[]).map((t) => t.title).sort()
  }

  test('several ids bring those threads, a child its parent; one id still works', async () => {
    const a = await thread('Choices from last week')
    const b = await thread('A ticket in an old thread')
    const parent = await thread('Parent')
    const child = await thread('Child', parent.id)
    await thread('Not asked for')
    assert.deepEqual(await list(`id=${a.id}&id=${b.id}&id=${child.id}`), [
      'A ticket in an old thread',
      'Choices from last week',
      'Parent',
    ])
    assert.deepEqual(await list(`id=${a.id}`), ['Choices from last week'])
  })
})
