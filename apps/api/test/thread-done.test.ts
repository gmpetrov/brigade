import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'
import type { ScheduleOperation } from '@brigade/contracts'
import { Hono } from 'hono'

// A thread's done (src/thread-done.ts, docs/board.md), against the API's development database
// (apps/api/.env), in an organization of its own removed at the end; skipped when no database
// answers:
// - complete_thread is refused while anything is open in the thread or its children, each named,
//   and the write itself checks again; never in a child or a schedule's run;
// - a person marks it done, or reopens it, as who may change it, whatever is open; not a child;
// - a person's message, or a ticket or pull request opened in it or a child, reopens it; the
//   teammate's own wake-up does not;
// - a merge wakes its teammate once, with its own prompt; not while it works, in a child, in a
//   schedule's run, once done, or while another pull request of it is open.
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

type Reply = { type: string; ok?: boolean; error?: string; output?: Record<string, unknown> }
type Sent = { type: string; [key: string]: unknown }

const until = async (check: () => boolean | Promise<boolean>, what: string) => {
  for (let i = 0; i < 200; i++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(`timed out waiting for ${what}`)
}
/** The scoped write hooks run after the write, not awaited: let them finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 200))

describe("a thread's done", { skip: !database && 'no database answers' }, () => {
  const suffix = randomUUID().slice(0, 8)
  const people = ['ada', 'bob', 'cat'] as const
  type Person = (typeof people)[number]
  const roles: Record<Person, string> = { ada: 'owner', bob: 'member', cat: 'admin' }
  const member = (p: Person) => `m-done-${p}-${suffix}`
  const user = (p: Person) => `u-done-${p}-${suffix}`
  const org = `org-done-${suffix}`
  let scope: { organizationId: string; workspaceId: string }
  let db: ReturnType<typeof scoped>
  let mac: string
  let cloud: string
  let riley: string
  let app: Hono
  let as: Person = 'ada'
  let restore: () => void

  before(async () => {
    const { auth } = await import('../src/auth.js')
    const { threads } = await import('../src/routes/threads.js')
    await prisma.organization.create({ data: { id: org, name: 'Done', slug: org } })
    for (const p of people) {
      await prisma.user.create({ data: { id: user(p), name: p, email: `${user(p)}@test.local` } })
      await prisma.member.create({
        data: { id: member(p), organizationId: org, userId: user(p), role: roles[p] },
      })
    }
    const workspaceId = (
      await prisma.workspace.create({ data: { organizationId: org, name: 'Done' } })
    ).id
    scope = { organizationId: org, workspaceId }
    db = scoped(scope)
    mac = (
      await db.computer.create({
        data: { kind: 'member_machine', memberId: member('ada'), name: 'Ada’s Mac' },
      } as never)
    ).id
    cloud = (
      await db.computer.create({
        data: { kind: 'cloud', name: 'Cloud computer', status: 'running' },
      } as never)
    ).id
    await db.account.create({
      data: {
        memberId: member('ada'),
        computerId: cloud,
        provider: 'claude_code',
        label: 'Claude',
        status: 'ready',
        isDefault: true,
      },
    } as never)
    riley = (await db.teammate.create({ data: { name: `Riley ${suffix}` } } as never)).id
    const getSession = auth.api.getSession
    ;(auth.api as { getSession: unknown }).getSession = async () => ({
      user: { id: user(as) },
      session: {
        id: `s-done-${suffix}`,
        activeOrganizationId: org,
        activeWorkspaceId: workspaceId,
      },
    })
    restore = () => ((auth.api as { getSession: unknown }).getSession = getSession)
    app = new Hono().route('/api/threads', threads)
    app.onError((error, c) =>
      'status' in error
        ? c.json({ error: error.message }, (error as { status: 400 }).status)
        : c.json({ error: String(error) }, 500),
    )
  })

  after(async () => {
    restore?.()
    if (scope) await prisma.workspace.deleteMany({ where: { id: scope.workspaceId } })
    await prisma.member.deleteMany({ where: { organizationId: org } })
    await prisma.organization.deleteMany({ where: { id: org } })
    await prisma.user.deleteMany({ where: { id: { in: people.map(user) } } })
  })

  let titles = 0
  /** A thread of Riley's that Ada started, at the top unless given its parent. */
  async function thread(
    options: {
      parentId?: string
      origin?: 'member' | 'trigger' | 'schedule' | 'child'
      status?: string
      computerId?: string
    } = {},
  ) {
    const computerId = options.computerId ?? mac
    const session = await db.session.create({
      data: {
        teammateId: riley,
        startedByMemberId: member('ada'),
        askedByMemberId: member('ada'),
        computerId,
        accountId:
          computerId === cloud
            ? (await db.account.findFirstOrThrow({ where: { computerId: cloud } })).id
            : null,
        title: `Thread ${++titles}`,
        status: options.status ?? 'running',
        origin: options.origin ?? (options.parentId ? 'child' : 'member'),
        ...(options.parentId ? { parentId: options.parentId, parentTeammateId: riley } : {}),
      } as never,
    })
    await db.threadTeammate.create({ data: { sessionId: session.id, teammateId: riley } as never })
    return session.id
  }

  const doneOf = (id: string) =>
    db.session.findFirstOrThrow({
      where: { id },
      select: { doneAt: true, doneSummary: true, doneByType: true, doneById: true },
    })

  /** Riley calls a schedule tool on its runner's connection; the API's answer. */
  async function call(sessionId: string, operation: object): Promise<Reply> {
    const { handleScheduleCall } = await import('../src/schedules.js')
    const { fakeRunner } = await import('./in-hub.js')
    const computerId = (await db.session.findFirstOrThrow({ where: { id: sessionId } })).computerId
    const runner = await fakeRunner(scope, computerId)
    const callId = randomUUID()
    try {
      await runner.run(() =>
        handleScheduleCall(
          { computerId, ...scope },
          {
            type: 'schedule.call',
            callId,
            sessionId,
            teammateId: riley,
            operation: operation as ScheduleOperation,
          },
          runner.reply as never,
        ),
      )
      const result = runner.sent.find((m) => m.callId === callId && m.type === 'connector.result')
      assert.ok(result, 'the call is answered at once')
      return result as unknown as Reply
    } finally {
      runner.close()
    }
  }
  const declare = (sessionId: string, summary = 'CSV export merged (#12)') =>
    call(sessionId, { name: 'complete_thread', summary })

  /** Refused, naming what is open; nothing written. */
  async function refused(sessionId: string, why: RegExp) {
    const reply = await declare(sessionId)
    assert.equal(reply.ok, false, 'refused')
    assert.match(reply.error ?? '', /^Not done yet/)
    assert.match(reply.error ?? '', why)
    assert.equal((await doneOf(sessionId)).doneAt, null)
  }
  async function declared(sessionId: string) {
    const reply = await declare(sessionId)
    assert.equal(reply.ok, true, reply.error)
    const row = await doneOf(sessionId)
    assert.ok(row.doneAt)
    assert.equal(row.doneSummary, 'CSV export merged (#12)')
    assert.equal(row.doneByType, 'teammate')
    assert.equal(row.doneById, riley)
  }

  const pull = (sessionId: string | null, number: number, state = 'open') =>
    db.pullRequest.create({
      data: {
        repository: 'acme/web',
        number,
        title: `Change ${number}`,
        headRef: `brigade/change-${number}`,
        baseRef: 'main',
        sessionId,
        authorTeammateId: riley,
        state,
      } as never,
    })

  test('refused while a ticket or a pull request is open in it or a child', async () => {
    const t = await thread()
    const question = await db.ticket.create({
      data: { sessionId: t, type: 'question', title: 'Which plan?' } as never,
    })
    await refused(t, /The question “Which plan\?” is still open/)
    await db.ticket.updateMany({ where: { id: question.id }, data: { status: 'resolved' } })

    const child = await thread({ parentId: t, status: 'idle' })
    const ticket = await db.ticket.create({
      data: { sessionId: child, type: 'request', title: 'Grant GitHub' } as never,
    })
    await refused(t, /The ticket “Grant GitHub” in the child thread “Thread \d+” is still open/)
    await db.ticket.updateMany({ where: { id: ticket.id }, data: { status: 'resolved' } })

    const own = await pull(t, 101)
    await refused(t, /Pull request #101 in acme\/web \(“Change 101”\) is still open/)
    await db.pullRequest.updateMany({ where: { id: own.id }, data: { state: 'merged' } })
    const childs = await pull(child, 102)
    await refused(t, /Pull request #102 in acme\/web .* in the child thread/)
    await db.pullRequest.updateMany({ where: { id: childs.id }, data: { state: 'closed' } })

    await declared(t)
    const entry = await prisma.auditEntry.findFirst({
      where: { workspaceId: scope.workspaceId, action: 'thread.done', targetId: t },
    })
    assert.equal(entry?.actorType, 'teammate')
  })

  test('refused while a child it waits for, a review among them, has not reported', async () => {
    const t = await thread()
    const child = await thread({ parentId: t })
    await db.session.updateMany({ where: { id: child }, data: { awaited: true } })
    await refused(t, /The child thread “Thread \d+” has not reported yet/)
    // A review is a child too.
    const reviewed = await pull(null, 103, 'merged')
    await db.pullRequest.updateMany({
      where: { id: reviewed.id },
      data: { reviewSessionId: child },
    })
    await refused(t, /The review of pull request #103 in acme\/web .* has not reported yet/)
    await db.session.updateMany({
      where: { id: child },
      data: {
        status: 'idle',
        report: { status: 'report', summary: 'Approved', at: new Date().toISOString() },
      },
    })
    await declared(t)
  })

  test('refused while a wake-up it set, or a person’s queued message, waits', async () => {
    const t = await thread()
    const wakeup = await db.wakeup.create({
      data: {
        sessionId: t,
        teammateId: riley,
        note: 'Check CI on #104',
        wakeAt: new Date(Date.now() + 600_000),
      },
    } as never)
    // A reply's wake-up is not one it set: it does not hold it.
    await db.wakeup.create({
      data: {
        sessionId: t,
        teammateId: riley,
        note: 'The reply',
        kind: 'reply',
        wakeAt: new Date(Date.now() + 600_000),
        sourceId: `gmail:${randomUUID()}`,
      },
    } as never)
    await refused(t, new RegExp(`Your wake-up at .*Check CI on #104.*id ${wakeup.id}`))
    await db.wakeup.updateMany({ where: { id: wakeup.id }, data: { status: 'cancelled' } })

    const event = (seq: number, data: Record<string, unknown>) =>
      db.sessionEvent.create({
        data: { sessionId: t, seq, type: data.type as string, at: new Date(), data },
      } as never)
    await event(1, {
      type: 'message.queued',
      messageId: 'msg-1',
      text: 'Also the PDF export',
      memberId: member('ada'),
      waitingFor: 'turn',
    })
    // A wake-up's or a report's queued prompt is not a person's.
    await event(2, {
      type: 'message.queued',
      messageId: 'msg-2',
      text: 'Report',
      memberId: null,
      waitingFor: 'turn',
    })
    await refused(t, /A message from a person waits for you in this thread/)
    await event(3, { type: 'message.user', messageId: 'msg-1', text: 'Also', memberId: null })
    await declared(t)
  })

  test('refused while a list item it works on is not ticked, unless what remains is a line', async () => {
    const t = await thread()
    const [ship, docs, rest] = ['shipcsvitem00001', 'docsitem00000001', 'restitem00000001']
    const file = await db.document.create({
      data: {
        path: `Projects/Acme/launch-${suffix}.md`,
        contentType: 'text/markdown',
        size: 1,
        text:
          `# Launch\n\n* [ ] Ship CSV <!-- item:${ship} -->\n` +
          `* [ ] Write the docs <!-- item:${docs} -->\n`,
      },
    } as never)
    await db.listItem.createMany({
      data: [
        { id: ship, documentId: file.id, text: 'Ship CSV' },
        { id: docs, documentId: file.id, text: 'Write the docs' },
      ],
    } as never)
    await db.listItemThread.createMany({
      data: [ship, docs].map((itemId) => ({ itemId, sessionId: t })),
    } as never)
    await refused(t, new RegExp(`The list item “Ship CSV” \\(id ${ship}, in Projects/Acme/`))
    // Ship CSV ticked; what remains of the docs a line of its own, attached here too.
    await db.document.updateMany({
      where: { id: file.id },
      data: {
        text:
          `# Launch\n\n* [x] Ship CSV <!-- item:${ship} -->\n` +
          `* [ ] Write the docs <!-- item:${docs} -->\n` +
          `  * [ ] Publish them once deployed <!-- item:${rest} -->\n`,
      },
    })
    await db.listItem.create({
      data: { id: rest, documentId: file.id, text: 'Publish', remainderOfId: docs },
    } as never)
    await db.listItemThread.create({ data: { itemId: rest, sessionId: t } } as never)
    await declared(t)
  })

  test('the write checks again: a ticket opened between the reads and it is not missed', async () => {
    const { completeThread } = await import('../src/thread-done.js')
    const t = await thread()
    const session = await db.session.findFirstOrThrow({ where: { id: t } })
    // Opened once every read is made, just before the write.
    const racing = db.$extends({
      query: {
        session: {
          async updateMany({ args, query }) {
            await prisma.ticket.create({
              data: { ...scope, sessionId: t, type: 'question', title: 'Opened meanwhile' },
            })
            return query(args)
          },
        },
      },
    }) as unknown as typeof db
    const out = await completeThread(
      racing,
      scope,
      session,
      { id: riley },
      {
        name: 'complete_thread',
        summary: 'Done',
      },
    )
    assert.ok('error' in out, 'refused')
    assert.match((out as { error: string }).error, /“Opened meanwhile” is still open/)
    assert.equal((await doneOf(t)).doneAt, null)
  })

  test('the write checks again: a person’s message stored between the reads and it is not missed', async () => {
    const { completeThread } = await import('../src/thread-done.js')
    const t = await thread()
    const session = await db.session.findFirstOrThrow({ where: { id: t } })
    // Queued once every read is made, just before the write: the runner stores it, and the
    // message route's reopen ran before there was anything to reopen.
    const racing = db.$extends({
      query: {
        session: {
          async updateMany({ args, query }) {
            await prisma.sessionEvent.create({
              data: {
                ...scope,
                sessionId: t,
                seq: 1,
                at: new Date(),
                type: 'message.queued',
                data: {
                  type: 'message.queued',
                  at: new Date().toISOString(),
                  messageId: 'also-the-pdf',
                  text: 'Also the PDF',
                  memberId: member('ada'),
                  waitingFor: 'turn',
                },
              },
            })
            return query(args)
          },
        },
      },
    }) as unknown as typeof db
    const out = await completeThread(
      racing,
      scope,
      session,
      { id: riley },
      {
        name: 'complete_thread',
        summary: 'Done',
      },
    )
    assert.ok('error' in out, 'refused')
    assert.match((out as { error: string }).error, /A message from a person waits for you/)
    assert.equal((await doneOf(t)).doneAt, null)
  })

  test('a person’s message the runner reports reopens it; a wake-up’s does not', async () => {
    const t = await thread({ computerId: cloud, status: 'running' })
    await markDone(t)
    const conn = await runner()
    const { sent, say } = conn
    try {
      const event = (seq: number, memberId: string | null) =>
        say({
          type: 'events',
          events: [
            {
              sessionId: t,
              seq,
              event: {
                at: new Date().toISOString(),
                type: 'message.queued',
                messageId: `m${seq}`,
                text: 'More',
                memberId,
                waitingFor: 'turn',
              },
            },
          ],
        })
      event(1, null)
      await until(() => sent.some((m) => m.type === 'ack' && m.seq === 1), 'the first ack')
      await new Promise((resolve) => setTimeout(resolve, 100))
      assert.ok((await doneOf(t)).doneAt, 'a message nobody wrote leaves it done')
      event(2, member('ada'))
      await until(async () => (await doneOf(t)).doneAt === null, 'the reopen')
    } finally {
      conn.close()
    }
  })

  test('a reopen that fails is tried again with its events, never lost once they are acknowledged', async () => {
    const { withPrismaClient } = await import('../src/db.js')
    const { fakeRunner } = await import('./in-hub.js')
    const { localHub } = await import('../src/hub/memory-host.js')
    const { onRunnerMessage } = await import('../src/hub/runner-messages.js')
    const t = await thread({ status: 'running' })
    await markDone(t)
    const runner = await fakeRunner(scope, mac)
    const hub = localHub(scope.workspaceId)
    const conn = hub.runners.get(mac)!
    let failures = 0
    // The reopen's write fails once, as a connection reset would.
    const failing = prisma.$extends({
      query: {
        session: {
          async updateMany({ args, query }) {
            const data = args.data as Record<string, unknown>
            if (args.where?.id === t && data.doneAt === null && failures === 0) {
              failures++
              throw new Error('connection reset during the reopen')
            }
            return query(args)
          },
        },
      },
    })
    const payload = JSON.stringify({
      type: 'events',
      events: [
        {
          sessionId: t,
          seq: 1,
          event: {
            type: 'message.queued',
            at: new Date().toISOString(),
            messageId: 'late',
            text: 'Also the PDF',
            memberId: member('ada'),
            waitingFor: 'turn',
          },
        },
      ],
    })
    const send = () => runner.run(() => onRunnerMessage(hub, conn, payload))
    try {
      await withPrismaClient(failing as never, send)
      await until(() => failures === 1, 'the failed reopen')
      await conn.queue
      const row = await db.session.findFirstOrThrow({ where: { id: t } })
      assert.equal(row.lastSeq, 0, 'the checkpoint did not move past the event')
      assert.ok(row.doneAt)
      assert.ok(!runner.sent.some((m) => m.type === 'ack' && m.seq === 1), 'not acknowledged')
      // The runner sends what was not acknowledged again.
      await send()
      await conn.queue
      await until(async () => (await doneOf(t)).doneAt === null, 'the reopen')
      assert.equal((await db.session.findFirstOrThrow({ where: { id: t } })).lastSeq, 1)
    } finally {
      for (const timer of conn.retries.values()) clearTimeout(timer)
      runner.close()
    }
  })

  test('never in a child, which reports, nor in a schedule’s run', async () => {
    const t = await thread()
    const child = await thread({ parentId: t })
    const reply = await declare(child)
    assert.equal(reply.ok, false)
    assert.match(reply.error ?? '', /call `report`/)
    const run = await thread({ origin: 'schedule' })
    const scheduled = await declare(run)
    assert.equal(scheduled.ok, false)
    assert.match(scheduled.error ?? '', /A schedule's run is not declared done/)
    for (const id of [child, run]) assert.equal((await doneOf(id)).doneAt, null)
    // A trigger's thread, at the top, is declared like a person's.
    await declared(await thread({ origin: 'trigger' }))
  })

  const request = (p: Person, path: string, init: { method?: string; body?: unknown } = {}) => {
    as = p
    return app.request(`/api/threads${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: init.body === undefined ? {} : { 'content-type': 'application/json' },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
    })
  }

  test('a person marks it done or reopens it, as who may change it, whatever is open', async () => {
    // On Ada's Mac: hers, and an admin's.
    const t = await thread({ status: 'idle' })
    await db.ticket.create({ data: { sessionId: t, type: 'question', title: 'Open' } as never })
    assert.equal((await request('bob', `/${t}/done`, { method: 'POST' })).status, 403)
    assert.equal((await doneOf(t)).doneAt, null)
    const marked = await request('ada', `/${t}/done`, { body: { summary: 'Shipped by hand' } })
    assert.equal(marked.status, 200, await marked.clone().text())
    const row = await doneOf(t)
    assert.ok(row.doneAt, 'an open ticket does not hold a person back')
    assert.equal(row.doneSummary, 'Shipped by hand')
    assert.equal(row.doneByType, 'member')
    assert.equal(row.doneById, member('ada'))
    // The thread says who.
    const shown = (await (await request('ada', `/${t}`)).json()) as {
      doneAt: string | null
      doneSummary: string | null
      doneBy: string | null
    }
    assert.ok(shown.doneAt)
    assert.equal(shown.doneSummary, 'Shipped by hand')
    assert.equal(shown.doneBy, 'ada')

    assert.equal((await request('bob', `/${t}/done`, { method: 'DELETE' })).status, 403)
    assert.ok((await doneOf(t)).doneAt)
    assert.equal((await request('cat', `/${t}/done`, { method: 'DELETE' })).status, 200)
    assert.deepEqual(await doneOf(t), {
      doneAt: null,
      doneSummary: null,
      doneByType: null,
      doneById: null,
    })
    // Without a line, too.
    assert.equal((await request('cat', `/${t}/done`, { method: 'POST' })).status, 200)
    assert.equal((await doneOf(t)).doneById, member('cat'))
    const actions = await prisma.auditEntry.findMany({
      where: { workspaceId: scope.workspaceId, targetId: t, action: { startsWith: 'thread.' } },
      orderBy: { id: 'asc' },
      select: { action: true, actorId: true },
    })
    assert.deepEqual(actions, [
      { action: 'thread.done', actorId: member('ada') },
      { action: 'thread.reopened', actorId: member('cat') },
      { action: 'thread.done', actorId: member('cat') },
    ])
    // A child shows in its parent.
    const child = await thread({ parentId: t })
    assert.equal((await request('ada', `/${child}/done`, { method: 'POST' })).status, 409)
    assert.equal((await doneOf(child)).doneAt, null)
  })

  /** Done, as complete_thread or Mark done leaves it. */
  const markDone = (id: string) =>
    db.session.updateMany({
      where: { id },
      data: {
        doneAt: new Date(),
        doneSummary: 'Shipped',
        doneByType: 'teammate',
        doneById: riley,
      },
    })

  /** The cloud computer's runner, connected: what it is sent. */
  let runnerId: string | undefined
  async function runner() {
    const { runnerSocket } = await import('../src/hub.js')
    runnerId ??= (
      await db.runner.create({
        data: { computerId: cloud, tokenHash: `hash-${randomUUID()}` },
      } as never)
    ).id
    const handle = runnerSocket({ id: runnerId, computerId: cloud, ...scope })
    const sent: Sent[] = []
    const ws = { send: (raw: string) => sent.push(JSON.parse(raw)), close: () => {} }
    handle.onMessage(
      JSON.stringify({
        type: 'hello',
        protocolVersion: 99,
        version: '0.0.0',
        platform: 'linux-x64',
      }),
      ws as never,
    )
    await until(() => sent.some((m) => m.type === 'welcome'), 'the welcome')
    return {
      sent,
      say: (message: object) => handle.onMessage(JSON.stringify(message), ws as never),
      close: () => handle.onClose(),
    }
  }

  test('its teammate’s own wake-up leaves it done; a person’s message reopens it', async () => {
    const { fireDueWakeups } = await import('../src/wakeups.js')
    const t = await thread({ computerId: cloud, status: 'idle' })
    await markDone(t)
    const conn = await runner()
    try {
      await db.wakeup.create({
        data: { sessionId: t, teammateId: riley, note: 'Check the deploy', wakeAt: new Date() },
      } as never)
      await fireDueWakeups(scope.workspaceId)
      await until(
        () =>
          conn.sent.some(
            (m) => m.type === 'thread.prompt' && String(m.text).includes('Check the deploy'),
          ),
        'the wake-up on the runner',
      )
      assert.ok((await doneOf(t)).doneAt, 'still done after its own wake-up')

      await db.session.updateMany({ where: { id: t }, data: { status: 'idle' } })
      const sent = await request('ada', `/${t}/messages`, { body: { text: 'Also the PDF' } })
      assert.equal(sent.status, 200, await sent.clone().text())
      assert.deepEqual(await doneOf(t), {
        doneAt: null,
        doneSummary: null,
        doneByType: null,
        doneById: null,
      })
    } finally {
      conn.close()
    }
  })

  test('a ticket or a pull request opened in it or a child reopens it', async () => {
    await import('../src/thread-archive.js')
    const t = await thread({ status: 'idle' })
    const child = await thread({ parentId: t, status: 'idle' })
    await markDone(t)
    // Closed already: nothing new waits.
    await db.ticket.create({
      data: { sessionId: child, type: 'question', title: 'Answered', status: 'resolved' } as never,
    })
    await settle()
    assert.ok((await doneOf(t)).doneAt)
    await db.ticket.create({
      data: { sessionId: child, type: 'question', title: 'Which plan?' } as never,
    })
    await settle()
    assert.equal((await doneOf(t)).doneAt, null, 'a ticket in its child reopens the root')
    await markDone(t)
    await pull(t, 201)
    await settle()
    assert.equal((await doneOf(t)).doneAt, null, 'a pull request opened in it reopens it')
  })

  const merged = (number: number) => ({
    number,
    title: `Change ${number}`,
    html_url: `https://github.com/acme/web/pull/${number}`,
    state: 'closed' as const,
    merged_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    user: { login: 'brigade-app[bot]' },
    head: { ref: `brigade/change-${number}`, sha: 'abc' },
    base: { ref: 'main' },
  })
  const mergeWakeups = (sessionId: string) =>
    db.wakeup.findMany({ where: { sessionId, sourceId: { startsWith: 'merged:' } } })

  test('a merge wakes its teammate once, with a prompt of its own, at once', async () => {
    const { pullRequestEvent } = await import('../src/pull-requests.js')
    const { wakeOnMerge } = await import('../src/thread-done.js')
    const t = await thread({ computerId: cloud, status: 'idle' })
    const row = await pull(t, 301)
    const conn = await runner()
    try {
      await pullRequestEvent(scope, 'acme/web', merged(301))
      const [wakeup, ...more] = await mergeWakeups(t)
      assert.ok(wakeup, 'woken')
      assert.equal(more.length, 0)
      assert.equal(wakeup.sourceId, 'merged:acme/web#301')
      assert.equal(wakeup.teammateId, riley)
      await until(
        () =>
          conn.sent.some(
            (m) =>
              m.type === 'thread.prompt' &&
              m.text ===
                'Pull request #301 in acme/web was merged. If nothing else remains of what was asked ' +
                  'here, declare this thread done with complete_thread (a line on what was delivered); ' +
                  'else say in a line what remains.',
          ),
        'the merge on the runner, as its own prompt',
      )
      // Heard again (Brigade's own merge, then the webhook): once.
      await db.session.updateMany({ where: { id: t }, data: { status: 'idle' } })
      assert.equal(await wakeOnMerge(scope, { ...row, state: 'merged' }), null)
      await pullRequestEvent(scope, 'acme/web', merged(301))
      assert.equal((await mergeWakeups(t)).length, 1)
    } finally {
      conn.close()
    }
  })

  test('no merge wake-up while it works, in a child, a schedule’s run, once done, or with another open', async () => {
    const { pullRequestEvent } = await import('../src/pull-requests.js')
    let number = 400
    /** Its pull request merged; `then` once it is open, before the merge (which opening undoes). */
    const quiet = async (sessionId: string, why: string, then?: () => Promise<unknown>) => {
      await pull(sessionId, ++number)
      await settle()
      await then?.()
      await pullRequestEvent(scope, 'acme/web', merged(number))
      assert.equal((await mergeWakeups(sessionId)).length, 0, why)
    }
    // It merged it itself, in its turn.
    await quiet(await thread({ status: 'running' }), 'running')
    const parent = await thread({ status: 'idle' })
    await quiet(await thread({ parentId: parent, status: 'idle' }), 'a child')
    await quiet(await thread({ origin: 'schedule', status: 'idle' }), "a schedule's run")
    const done = await thread({ status: 'idle' })
    await quiet(done, 'done already', () => markDone(done))
    const busy = await thread({ status: 'idle' })
    await pull(busy, 499)
    await quiet(busy, 'another of its pull requests is open')
    // And one that is woken, the same way, so that the above is not a merge that wakes nobody.
    const woken = await thread({ status: 'idle' })
    await pull(woken, 498)
    await pullRequestEvent(scope, 'acme/web', merged(498))
    assert.equal((await mergeWakeups(woken)).length, 1)
  })

  test('a merge a teammate makes from another thread wakes the one that opened it; not its own', async () => {
    const { notePullRequestCall } = await import('../src/pull-requests.js')
    const mergeCall = (sessionId: string, number: number) =>
      notePullRequestCall(db, scope, {
        sessionId,
        teammateId: riley,
        operation: 'github_merge_pull_request',
        input: { repository: 'acme/web', number },
        output: { merged: true, method: 'squash', sha: 'abc' },
      })
    const opener = await thread({ status: 'idle' })
    await pull(opener, 501)
    // Merged by Riley in another thread: the one that opened it hears it.
    await mergeCall(await thread(), 501)
    assert.equal((await mergeWakeups(opener)).length, 1)
    // Merged in its own turn: it knows.
    const own = await thread({ status: 'running' })
    await pull(own, 502)
    await mergeCall(own, 502)
    assert.equal((await mergeWakeups(own)).length, 0)
  })

  test('a pull request GitHub told of first, then linked to its thread, reopens it', async () => {
    const { notePullRequestCall } = await import('../src/pull-requests.js')
    const t = await thread({ status: 'running' })
    // The webhook's row, without its thread or author.
    const hooked = await pull(null, 601)
    await db.pullRequest.updateMany({ where: { id: hooked.id }, data: { authorTeammateId: null } })
    await markDone(t)
    await notePullRequestCall(db, scope, {
      sessionId: t,
      teammateId: riley,
      operation: 'github_create_pull_request',
      input: { repository: 'acme/web' },
      output: { number: 601, title: 'Change 601', head: 'brigade/change-601', base: 'main' },
    })
    const row = await db.pullRequest.findFirstOrThrow({ where: { number: 601 } })
    assert.equal(row.sessionId, t)
    assert.equal((await doneOf(t)).doneAt, null)
  })
})
