import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'
import { Hono } from 'hono'

// POST /api/threads/:id/choices/dismiss: a person closes the choices card open in a thread
// without picking (docs/board.md). It waits on nobody then, no turn starts, and a later card
// waits again. Against the API's development database (apps/api/.env), in an organization of
// its own removed at the end; skipped when no database answers.
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

describe('dismissing choices', { skip: !database && 'no database answers' }, () => {
  const suffix = randomUUID().slice(0, 8)
  const ids = {} as Record<'org' | 'user' | 'member' | 'workspace' | 'computer' | 'riley', string>
  let db: ReturnType<typeof scoped>
  let app: Hono
  let restore: () => void

  before(async () => {
    const { auth } = await import('../src/auth.js')
    const { threads } = await import('../src/routes/threads.js')
    ids.org = `org-dismiss-${suffix}`
    ids.user = `user-dismiss-${suffix}`
    ids.member = `m-dismiss-${suffix}`
    await prisma.organization.create({
      data: { id: ids.org, name: 'Dismiss', slug: `dismiss-${suffix}` },
    })
    await prisma.user.create({
      data: { id: ids.user, name: 'Ada', email: `${ids.user}@test.local` },
    })
    await prisma.member.create({
      data: { id: ids.member, organizationId: ids.org, userId: ids.user, role: 'owner' },
    })
    ids.workspace = (
      await prisma.workspace.create({ data: { organizationId: ids.org, name: 'Dismiss' } })
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

  const choices = (question: string) => ({
    question,
    options: [
      { id: 'a', label: 'A · Today' },
      { id: 'b', label: 'B · Desk' },
    ],
  })

  /** Ada's idle thread, its teammate's turn ending on a choices card. */
  async function offered(question: string) {
    const t = await db.session.create({
      data: {
        teammateId: ids.riley,
        startedByMemberId: ids.member,
        computerId: ids.computer,
        title: question,
        status: 'idle',
      },
    } as never)
    let seq = 0
    const event = (type: string, data: Record<string, unknown>) =>
      prisma.sessionEvent.create({
        data: {
          organizationId: ids.org,
          workspaceId: ids.workspace,
          sessionId: t.id,
          seq: ++seq,
          at: new Date(),
          type,
          data: { type, ...data },
        },
      })
    await event('message.user', { text: 'Rename Home', memberId: ids.member })
    await event('tool.started', {
      toolCallId: 'm1:offer_choices',
      toolName: 'offer_choices',
      input: choices(question),
    })
    await event('turn.completed', {})
    return { id: t.id as string, offer: 2, event }
  }

  const dismiss = (id: string) =>
    app.request(`/api/threads/${id}/choices/dismiss`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })

  test('it closes the card, which waits on nobody; no turn starts; a later one waits', async () => {
    const { choicesWaitingAmong } = await import('../src/choices-waiting.js')
    const t = await offered('Which name for Home?')
    assert.ok((await choicesWaitingAmong(db, [t.id])).has(t.id))
    const before = await db.session.findFirst({ where: { id: t.id } })

    const res = await dismiss(t.id)
    assert.equal(res.status, 200, await res.clone().text())
    const after = await db.session.findFirst({ where: { id: t.id } })
    assert.equal(after?.choicesDismissedSeq, t.offer)
    assert.equal(after?.status, 'idle', 'no turn started')
    assert.equal(after?.updatedAt.getTime(), before?.updatedAt.getTime(), 'its stopped clock')
    assert.equal((await choicesWaitingAmong(db, [t.id])).size, 0)

    // Nothing open any more: refused.
    assert.equal((await dismiss(t.id)).status, 409)

    // The teammate offers again: that card waits, and is dismissed in its turn.
    await t.event('message.user', { text: 'Wake-up', memberId: null })
    await t.event('tool.started', {
      toolCallId: 'm2:offer_choices',
      toolName: 'offer_choices',
      input: choices('Which icon?'),
    })
    await t.event('turn.completed', {})
    assert.equal((await choicesWaitingAmong(db, [t.id])).get(t.id)?.question, 'Which icon?')
  })

  test('a thread whose card was answered has nothing to dismiss', async () => {
    const t = await offered('Which color?')
    await t.event('message.user', { text: 'Go with A · Today', memberId: ids.member })
    assert.equal((await dismiss(t.id)).status, 409)
  })
})
