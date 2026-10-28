import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'
import { Hono } from 'hono'
import { ASIDE_PROTOCOL } from '@brigade/contracts'

// A person writes in a thread whose teammate waits on them (routes/threads.ts), against the
// API's development database (apps/api/.env), in an organization of its own removed at the end;
// skipped when no database answers:
// - waiting on a ticket the teammate opened, the message goes to its runner, which hands it to
//   the teammate at once while the ticket stays open (ASIDE_PROTOCOL);
// - waiting on a decision that holds a call (an approval), or on a runner from before that,
//   it is refused as before;
// - a decision on an approval decided already is refused, rather than sent to the runner,
//   where it would continue the teammate's turn with whatever that turn waits on now.
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
  'a message while a teammate waits on a person',
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
      ids.org = `org-waiting-${suffix}`
      ids.user = `user-waiting-${suffix}`
      ids.member = `m-waiting-${suffix}`
      await prisma.organization.create({
        data: { id: ids.org, name: 'Waiting', slug: `waiting-${suffix}` },
      })
      await prisma.user.create({
        data: { id: ids.user, name: 'Ada', email: `${ids.user}@test.local` },
      })
      await prisma.member.create({
        data: { id: ids.member, organizationId: ids.org, userId: ids.user, role: 'owner' },
      })
      ids.workspace = (
        await prisma.workspace.create({ data: { organizationId: ids.org, name: 'Waiting' } })
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

    /** Riley's thread, waiting on the person, with the tickets it has open. */
    async function waitingThread(tickets: { type: 'request' | 'approval'; payload: object }[]) {
      const session = await db.session.create({
        data: {
          teammateId: ids.riley,
          startedByMemberId: ids.member,
          computerId: ids.computer,
          title: 'Hyperdrive',
          status: 'waiting',
        } as never,
      })
      await db.threadTeammate.create({
        data: { sessionId: session.id, teammateId: ids.riley } as never,
      })
      const made = []
      for (const ticket of tickets)
        made.push(
          await db.ticket.create({
            data: { sessionId: session.id, title: 'Riley asks', ...ticket } as never,
          }),
        )
      return { id: session.id, tickets: made }
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

    const ticket = {
      type: 'request' as const,
      payload: {
        source: 'harness',
        requestId: `toolu-${suffix}`,
        teammateId: '',
        asks: [{ id: 'perm', type: 'action', title: 'Add Hyperdrive: Edit to the token' }],
      },
    }

    test('waiting on its own ticket, the message goes to the teammate, and the ticket stays open', async () => {
      const thread = await waitingThread([ticket])
      const conn = await runner(ASIDE_PROTOCOL)
      try {
        const res = await post(`/${thread.id}/messages`, { text: 'Which token is it?' })
        assert.equal(res.status, 200, await res.clone().text())
        await until(
          () =>
            forThread(conn.sent, 'thread.prompt', thread.id).some(
              (m) => m.text === 'Which token is it?',
            ),
          'the message on its runner',
        )
        const open = await db.ticket.findFirst({ where: { id: thread.tickets[0]!.id } })
        assert.equal(open?.status, 'open')
      } finally {
        conn.close()
      }
    })

    test('a runner from before that refuses it as before, saying why', async () => {
      const thread = await waitingThread([ticket])
      const conn = await runner(ASIDE_PROTOCOL - 1)
      try {
        const res = await post(`/${thread.id}/messages`, { text: 'Which token is it?' })
        assert.equal(res.status, 409)
        assert.match(await res.text(), /update Brigade on this computer/)
        assert.deepEqual(forThread(conn.sent, 'thread.prompt', thread.id), [])
      } finally {
        conn.close()
      }
    })

    test('waiting on an approval that holds a call, the message waits for the decision', async () => {
      const thread = await waitingThread([
        ticket,
        {
          type: 'approval',
          payload: { source: 'harness', approvalId: `approval-${suffix}`, toolName: 'Bash' },
        },
      ])
      const conn = await runner(ASIDE_PROTOCOL)
      try {
        const res = await post(`/${thread.id}/messages`, { text: 'Why this command?' })
        assert.equal(res.status, 409)
        assert.match(await res.text(), /Approve or deny the pending request first/)
        assert.deepEqual(forThread(conn.sent, 'thread.prompt', thread.id), [])
      } finally {
        conn.close()
      }
    })

    test('a decision on an approval decided already is refused, never sent to the runner', async () => {
      const approvalId = `cred-${suffix}`
      const thread = await waitingThread([ticket])
      // A credential's approval, decided: its ticket's id is the approval's.
      await db.ticket.create({
        data: {
          id: approvalId,
          sessionId: thread.id,
          type: 'approval',
          status: 'approved',
          title: 'Riley: use CLOUDFLARE_API_TOKEN',
          payload: { credentialAction: 'use', teammateId: ids.riley },
        } as never,
      })
      const conn = await runner(ASIDE_PROTOCOL)
      try {
        const res = await post(`/${thread.id}/approvals`, { approvalId, approved: true })
        assert.equal(res.status, 409)
        assert.match(await res.text(), /decided already/)
        assert.deepEqual(forThread(conn.sent, 'thread.approval', thread.id), [])
      } finally {
        conn.close()
      }
    })
  },
)
