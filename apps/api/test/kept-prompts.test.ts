import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'
import { Hono } from 'hono'

// A thread whose id the browser chose (POST /api/threads with `id`), so that it opens before it
// exists, against the API's development database (apps/api/.env), in an organization of its own
// removed at the end; skipped when no database answers:
// - a new id starts the thread under it, and its first message reaches the runner;
// - an id a thread has already is refused, and that thread gets nothing: else a member could
//   write in another's thread, a private one too, by its id;
// - an id not shaped as a thread's is refused before anything is made: it names storage folders;
// - files sent with a thread that did not start (its computer offline) leave it, so that the
//   message, given back to the member, can be sent again with them.
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

type Sent = { type: string; [key: string]: unknown }

const prompts = (sent: Sent[], sessionId: string) =>
  sent.filter(
    (m) =>
      m.type === 'thread.prompt' &&
      (m.thread as { sessionId?: string } | undefined)?.sessionId === sessionId,
  )

const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(`timed out waiting for ${what}`)
}

/** An id as the dashboard makes one (lib/thread-ids.ts). */
const newId = () =>
  `c${Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => (b % 36).toString(36)).join('')}`

describe(
  'a prompt kept before its sending failed',
  { skip: !database && 'no database answers' },
  () => {
    const suffix = randomUUID().slice(0, 8)
    const ids = {} as Record<
      'org' | 'user' | 'member' | 'other' | 'workspace' | 'computer' | 'runner' | 'riley',
      string
    >
    let db: ReturnType<typeof scoped>
    let scope: { organizationId: string; workspaceId: string }
    let app: Hono
    let restore: () => void
    let sent: Sent[]
    let close: () => void

    before(async () => {
      const { auth } = await import('../src/auth.js')
      const { threads } = await import('../src/routes/threads.js')
      ids.org = `org-kept-${suffix}`
      ids.user = `user-kept-${suffix}`
      ids.member = `m-kept-${suffix}`
      ids.other = `m-kept-other-${suffix}`
      await prisma.organization.create({
        data: { id: ids.org, name: 'Kept', slug: `kept-${suffix}` },
      })
      await prisma.user.createMany({
        data: [
          { id: ids.user, name: 'Ada', email: `${ids.user}@test.local` },
          { id: `${ids.user}-bob`, name: 'Bob', email: `${ids.user}-bob@test.local` },
        ],
      })
      await prisma.member.createMany({
        data: [
          { id: ids.member, organizationId: ids.org, userId: ids.user, role: 'owner' },
          { id: ids.other, organizationId: ids.org, userId: `${ids.user}-bob`, role: 'member' },
        ],
      })
      ids.workspace = (
        await prisma.workspace.create({ data: { organizationId: ids.org, name: 'Kept' } })
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
      sent = []
      close = await connect()
    })

    /** Ada's computer, its runner connected: what it is sent goes in `sent`. */
    async function connect() {
      const { runnerSocket } = await import('../src/hub.js')
      const { PROTOCOL_VERSION } = await import('@brigade/contracts')
      const handle = runnerSocket({ id: ids.runner, computerId: ids.computer, ...scope })
      const ws = { send: (raw: string) => sent.push(JSON.parse(raw)), close: () => {} }
      const welcomed = sent.filter((m) => m.type === 'welcome').length
      handle.onMessage(
        JSON.stringify({
          type: 'hello',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.0.0',
          platform: 'linux-x64',
        }),
        ws as never,
      )
      await until(() => sent.filter((m) => m.type === 'welcome').length > welcomed, 'the welcome')
      return () => handle.onClose()
    }

    after(async () => {
      close?.()
      restore?.()
      if (ids.workspace) await prisma.workspace.deleteMany({ where: { id: ids.workspace } })
      await prisma.member.deleteMany({ where: { organizationId: ids.org } })
      await prisma.organization.deleteMany({ where: { id: ids.org } })
      await prisma.user.deleteMany({ where: { id: { in: [ids.user, `${ids.user}-bob`] } } })
    })

    const start = (text: string) =>
      app.request('/api/threads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ teammateId: ids.riley, computerId: ids.computer, text }),
      })

    test('kept, then failing: the thread starts and its command waits for the runner', async () => {
      const { localHub } = await import('../src/hub/memory-host.js')
      const { keepCommand } = await import('../src/runner-commands.js')
      const hub = localHub(ids.workspace)
      const dispatch = hub.dispatch.bind(hub)
      hub.dispatch = async (computer, message) => {
        await keepCommand({ ...computer, ...scope }, message as never)
        throw new Error('')
      }
      try {
        const res = await start('Through a reset')
        assert.equal(res.status, 201, await res.clone().text())
        const { id } = (await res.json()) as { id: string }
        const kept = await db.runnerCommand.findMany({ where: { sessionId: id } })
        assert.equal(kept.length, 1)
        assert.equal(kept[0]!.status, 'pending')
        const thread = await db.session.findFirst({ where: { id } })
        assert.notEqual(thread?.status, 'failed')
      } finally {
        hub.dispatch = dispatch
      }
    })

    test('failing before it was kept: refused as before', async () => {
      const { localHub } = await import('../src/hub/memory-host.js')
      const hub = localHub(ids.workspace)
      const dispatch = hub.dispatch.bind(hub)
      hub.dispatch = async () => {
        throw new Error('')
      }
      const before = await db.session.count()
      try {
        const res = await start('Not kept')
        assert.equal(res.status, 500)
        assert.equal(await db.session.count({ where: { status: 'failed' } }), 1)
        assert.equal(await db.session.count(), before + 1)
      } finally {
        hub.dispatch = dispatch
      }
    })
  },
)
