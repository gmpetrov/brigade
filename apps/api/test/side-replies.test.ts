import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'
import { Hono } from 'hono'
import { SIDE_REPLY_PROTOCOL } from '@brigade/contracts'
import { sessionStub } from './session-stub.js'

// A person acts on a message answered on the side (routes/threads.ts, docs/side-replies.md),
// against the API's development database (apps/api/.env), in an organization of its own removed
// at the end; skipped when no database answers:
// - one its side reply settled is sent again to have it run, with no side reply again, steered
//   when asked: whatever the runner still remembers (it may have restarted since);
// - one still queued is steered or kept on its runner, and queued again it changes nothing;
// - a runner from before side replies is refused keep and queue.
const envFile = new URL('../.env', import.meta.url)
if (!process.env.DATABASE_URL && existsSync(envFile))
  process.env.DATABASE_URL = parseEnv(readFileSync(envFile, 'utf8')).DATABASE_URL
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')

const { prisma, scoped } = await import('../src/db.js')
const database = await Promise.race([
  prisma.$queryRaw`select 1`.then(() => true),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
]).catch(() => false)

type Sent = { type: string; [key: string]: unknown }

/** Sent for this thread (a command not acknowledged comes again on the next connection). */
const forThread = (sent: Sent[], type: string, sessionId: string) =>
  sent.filter(
    (m) =>
      m.type === type &&
      ((m.thread as { sessionId?: string } | undefined)?.sessionId ?? m.sessionId) === sessionId,
  )

const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(`timed out waiting for ${what}`)
}

describe(
  'actions on a message answered on the side',
  { skip: !database && 'no database answers' },
  () => {
    const suffix = randomUUID().slice(0, 8)
    const ids = {} as Record<
      'org' | 'user' | 'member' | 'workspace' | 'computer' | 'runner' | 'riley',
      string
    >
    let db: ReturnType<typeof scoped>
    let scope: { organizationId: string; workspaceId: string }
    let app: Hono
    let restore: () => void

    before(async () => {
      const { auth } = await import('../src/auth.js')
      const { threads } = await import('../src/routes/threads.js')
      ids.org = `org-side-${suffix}`
      ids.user = `user-side-${suffix}`
      ids.member = `m-side-${suffix}`
      await prisma.organization.create({
        data: { id: ids.org, name: 'Side', slug: `side-${suffix}` },
      })
      await prisma.user.create({
        data: { id: ids.user, name: 'Ada', email: `${ids.user}@test.local` },
      })
      await prisma.member.create({
        data: { id: ids.member, organizationId: ids.org, userId: ids.user, role: 'owner' },
      })
      ids.workspace = (
        await prisma.workspace.create({ data: { organizationId: ids.org, name: 'Side' } })
      ).id
      scope = { organizationId: ids.org, workspaceId: ids.workspace }
      db = scoped(scope)
      ids.computer = (
        await db.computer.create({
          data: { kind: 'member_machine', memberId: ids.member, name: 'Laptop', status: 'running' },
        } as never)
      ).id
      ids.runner = (
        await db.runner.create({
          data: { computerId: ids.computer, tokenHash: `hash-${suffix}` },
        } as never)
      ).id
      await db.account.create({
        data: {
          memberId: ids.member,
          computerId: ids.computer,
          provider: 'claude_code',
          label: 'Claude',
          status: 'ready',
        },
      } as never)
      ids.riley = (await db.teammate.create({ data: { name: `Riley ${suffix}` } } as never)).id
      // Signed in as Ada, without a cookie: the session is the test's.
      const getSession = auth.api.getSession
      ;(auth.api as { getSession: unknown }).getSession = sessionStub(() => ({
        user: { id: ids.user },
        session: {
          id: `session-${suffix}`,
          activeOrganizationId: ids.org,
          activeWorkspaceId: ids.workspace,
        },
      }))
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

    /** Riley's thread, running, with a person's message queued and, if settled, read on the side. */
    async function threadWith(settled: boolean) {
      const session = await db.session.create({
        data: {
          teammateId: ids.riley,
          startedByMemberId: ids.member,
          computerId: ids.computer,
          title: 'CSV export',
          status: 'running',
          lastSeq: settled ? 2 : 1,
        } as never,
      })
      await db.threadTeammate.create({
        data: { sessionId: session.id, teammateId: ids.riley } as never,
      })
      const messageId = `msg-${randomUUID().slice(0, 8)}`
      const text = 'Is it the date format?'
      const events = [
        { type: 'message.queued', messageId, text, memberId: ids.member, waitingFor: 'turn' },
        ...(settled
          ? [
              {
                type: 'message.user',
                text,
                memberId: ids.member,
                messageId,
                side: { text: 'Yes, formatted twice.', route: 'answer' },
              },
            ]
          : []),
      ]
      for (const [i, event] of events.entries())
        await db.sessionEvent.create({
          data: {
            sessionId: session.id,
            seq: i + 1,
            type: event.type,
            at: new Date(),
            data: { ...event, at: new Date().toISOString() },
          },
        } as never)
      return { id: session.id, messageId, text }
    }

    /** Riley's computer, its runner connected with this protocol: what it is sent. */
    async function runner(protocolVersion: number) {
      const { runnerSocket } = await import('../src/hub.js')
      const handle = runnerSocket({ id: ids.runner, computerId: ids.computer, ...scope })
      const sent: Sent[] = []
      const ws = { send: (raw: string) => sent.push(JSON.parse(raw)), close: () => {} }
      handle.onMessage(
        JSON.stringify({ type: 'hello', protocolVersion, version: '0.0.0', platform: 'linux-x64' }),
        ws as never,
      )
      await until(() => sent.some((m) => m.type === 'welcome'), 'the welcome')
      return { sent, close: () => handle.onClose() }
    }

    const post = (path: string, body: unknown) =>
      app.request(`/api/threads${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })

    test('a settled message is sent again to run, with no side reply, and steered when asked', async () => {
      const conn = await runner(SIDE_REPLY_PROTOCOL)
      try {
        const queued = await threadWith(true)
        const res = await post(`/${queued.id}/messages/${queued.messageId}`, { action: 'queue' })
        assert.equal(res.status, 200, await res.clone().text())
        await until(
          () => forThread(conn.sent, 'thread.prompt', queued.id).length === 1,
          'the message on its runner',
        )
        const prompt = forThread(conn.sent, 'thread.prompt', queued.id)[0]!
        assert.equal(prompt.messageId, queued.messageId)
        assert.equal(prompt.text, queued.text)
        assert.equal(prompt.memberId, ids.member)
        assert.equal(prompt.settled, true)
        assert.equal(prompt.steer, undefined)
        assert.deepEqual(forThread(conn.sent, 'thread.queued', queued.id), [])

        const steered = await threadWith(true)
        const again = await post(`/${steered.id}/messages/${steered.messageId}`, {
          action: 'steer',
        })
        assert.equal(again.status, 200, await again.clone().text())
        await until(
          () => forThread(conn.sent, 'thread.prompt', steered.id).length === 1,
          'the steered message on its runner',
        )
        const given = forThread(conn.sent, 'thread.prompt', steered.id)[0]!
        assert.equal(given.settled, true)
        assert.equal(given.steer, true)
      } finally {
        conn.close()
      }
    })

    test('one still queued is steered or kept on its runner, and queued again changes nothing', async () => {
      const conn = await runner(SIDE_REPLY_PROTOCOL)
      try {
        const thread = await threadWith(false)
        for (const action of ['steer', 'keep', 'queue'])
          assert.equal(
            (await post(`/${thread.id}/messages/${thread.messageId}`, { action })).status,
            200,
          )
        await until(
          () => forThread(conn.sent, 'thread.queued', thread.id).length === 2,
          'steer and keep on its runner',
        )
        assert.deepEqual(
          forThread(conn.sent, 'thread.queued', thread.id).map((m) => m.action),
          ['steer', 'keep'],
        )
        assert.deepEqual(forThread(conn.sent, 'thread.prompt', thread.id), [])
      } finally {
        conn.close()
      }
    })

    test('a runner from before side replies is refused keep and queue', async () => {
      const conn = await runner(SIDE_REPLY_PROTOCOL - 1)
      try {
        const thread = await threadWith(true)
        for (const action of ['keep', 'queue']) {
          const res = await post(`/${thread.id}/messages/${thread.messageId}`, { action })
          assert.equal(res.status, 409)
          assert.match(await res.text(), /too old for asides/)
        }
        assert.deepEqual(forThread(conn.sent, 'thread.prompt', thread.id), [])
      } finally {
        conn.close()
      }
    })

    test('two clicks racing to run a settled message send it once', async () => {
      const conn = await runner(SIDE_REPLY_PROTOCOL)
      try {
        const thread = await threadWith(true)
        const replies = await Promise.all([
          post(`/${thread.id}/messages/${thread.messageId}`, { action: 'queue' }),
          post(`/${thread.id}/messages/${thread.messageId}`, { action: 'steer' }),
        ])
        for (const res of replies) assert.equal(res.status, 200, await res.clone().text())
        await until(
          () => forThread(conn.sent, 'thread.prompt', thread.id).length >= 1,
          'the message on its runner',
        )
        await new Promise((resolve) => setTimeout(resolve, 300))
        assert.equal(forThread(conn.sent, 'thread.prompt', thread.id).length, 1)
        assert.equal(
          await prisma.runnerCommand.count({
            where: { sessionId: thread.id, type: 'thread.prompt' },
          }),
          1,
        )
      } finally {
        conn.close()
      }
    })

    test('a settled message queued again stays queued for a page that starts after it', async () => {
      const { historyContext } = await import('../src/thread-history.js')
      const thread = await threadWith(true)
      await db.sessionEvent.create({
        data: {
          sessionId: thread.id,
          seq: 3,
          type: 'message.queued',
          at: new Date(),
          data: {
            type: 'message.queued',
            messageId: thread.messageId,
            text: thread.text,
            memberId: ids.member,
            waitingFor: 'turn',
            at: new Date().toISOString(),
          },
        },
      } as never)
      const context = await historyContext(thread.id, 4)
      const queued = context.filter(
        (e) => e.event.type === 'message.queued' && e.event.messageId === thread.messageId,
      )
      assert.deepEqual(
        queued.map((e) => e.seq),
        [3],
      )
      // Read since: it is queued no more.
      await db.sessionEvent.create({
        data: {
          sessionId: thread.id,
          seq: 4,
          type: 'message.user',
          at: new Date(),
          data: {
            type: 'message.user',
            messageId: thread.messageId,
            text: thread.text,
            memberId: ids.member,
            at: new Date().toISOString(),
          },
        },
      } as never)
      assert.equal(
        (await historyContext(thread.id, 5)).some((e) => e.event.type === 'message.queued'),
        false,
      )
    })
  },
)
