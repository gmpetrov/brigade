import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'
import { OUTBOX_PROTOCOL } from '@brigade/contracts'

// Work the API keeps as rows rather than in its memory (docs/deployment-plan.md, Phase 2), against
// the API's development database (apps/api/.env), in an organization of its own removed at the
// end; skipped when no database answers:
// - a write held for approval is made once when the decision comes after an API restart, and its
//   result reaches the thread as a message; an identical call meanwhile joins the open ticket;
// - a command for a runner is kept until acknowledged: sent again after a reconnect, not once
//   acknowledged, and still sent to a cloud computer that took more than 10 minutes to start;
// - a GitHub delivery kept before a restart is processed by the tick, once, and a delivery sent
//   again is recognised;
// - two tries at once to deliver one event to a trigger start one thread, and a try a crash cut
//   off is taken over.
const envFile = new URL('../.env', import.meta.url)
if (!process.env.DATABASE_URL && existsSync(envFile))
  process.env.DATABASE_URL = parseEnv(readFileSync(envFile, 'utf8')).DATABASE_URL
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
const WEBHOOK_SECRET = 'durable-work-secret'
process.env.GITHUB_APP_WEBHOOK_SECRET = WEBHOOK_SECRET

const { prisma, scoped } = await import('../src/db.js')
const database = await Promise.race([
  prisma.$queryRaw`select 1`.then(() => true),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
]).catch(() => false)

/** What a fake runner's socket was sent, as the hub sends it. */
type Sent = { type: string; commandId?: string; callId?: string; [key: string]: unknown }
const socket = () => {
  const sent: Sent[] = []
  return { sent, ws: { send: (raw: string) => sent.push(JSON.parse(raw)), close: () => {} } }
}

const until = async (check: () => Promise<boolean> | boolean, what: string) => {
  for (let i = 0; i < 200; i++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(`timed out waiting for ${what}`)
}

describe('work kept in the database', { skip: !database && 'no database answers' }, () => {
  const suffix = randomUUID().slice(0, 8)
  const ids = {} as Record<
    'org' | 'workspace' | 'owner' | 'laptop' | 'cloud' | 'runner' | 'sam' | 'gmail' | 'session',
    string
  >
  let db: ReturnType<typeof scoped>
  let scope: { organizationId: string; workspaceId: string }
  const realFetch = globalThis.fetch
  /** Gmail's sends, as the stub received them. */
  const sends: unknown[] = []

  before(async () => {
    ids.org = `org-durable-${suffix}`
    await prisma.organization.create({
      data: { id: ids.org, name: 'Durable', slug: `durable-${suffix}` },
    })
    await prisma.user.create({
      data: { id: `owner-${suffix}`, name: 'Ada', email: `owner-${suffix}@test.local` },
    })
    ids.owner = `m-owner-${suffix}`
    await prisma.member.create({
      data: { id: ids.owner, organizationId: ids.org, userId: `owner-${suffix}`, role: 'owner' },
    })
    ids.workspace = (
      await prisma.workspace.create({ data: { organizationId: ids.org, name: 'Durable' } })
    ).id
    scope = { organizationId: ids.org, workspaceId: ids.workspace }
    db = scoped(scope)
    ids.laptop = (
      await db.computer.create({
        data: { kind: 'member_machine', memberId: ids.owner, name: 'Laptop', status: 'running' },
      } as never)
    ).id
    ids.cloud = (
      await db.computer.create({
        data: { kind: 'cloud', name: 'Cloud', status: 'stopped' },
      } as never)
    ).id
    ids.runner = (
      await db.runner.create({
        data: { computerId: ids.laptop, tokenHash: `hash-${suffix}` },
      } as never)
    ).id
    for (const computerId of [ids.laptop, ids.cloud])
      await db.account.create({
        data: {
          memberId: ids.owner,
          computerId,
          provider: 'claude_code',
          label: 'Claude',
          status: 'ready',
        },
      } as never)
    // Sam asks before each write through an App.
    ids.sam = (
      await db.teammate.create({
        data: { name: `Sam ${suffix}`, permissionPolicy: { connectorWrites: 'ask' } },
      } as never)
    ).id
    const { sealSecret } = await import('../src/vault.js')
    const app = await db.app.create({
      data: { key: 'gmail', createdByMemberId: ids.owner } as never,
    })
    ids.gmail = (
      await db.connection.create({
        data: {
          appId: app.id,
          kind: 'gmail',
          label: 'Gmail',
          externalAccount: 'support@acme.test',
          createdByMemberId: ids.owner,
          vaultSecretId: await sealSecret(db, scope, {
            accessToken: 'token',
            refreshToken: null,
            expiresAt: Date.now() + 3600_000,
          }),
        } as never,
      })
    ).id
    await db.grant.create({
      data: { teammateId: ids.sam, connectionId: ids.gmail, scope: 'read_write' } as never,
    })
    ids.session = (
      await db.session.create({
        data: {
          teammateId: ids.sam,
          startedByMemberId: ids.owner,
          computerId: ids.laptop,
          title: 'Refund',
          status: 'waiting',
        } as never,
      })
    ).id
    await db.threadTeammate.create({
      data: { sessionId: ids.session, teammateId: ids.sam } as never,
    })
    // Gmail answers sends; nothing else leaves.
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url instanceof Request ? url.url : url)
      if (href.includes('/messages/send')) {
        sends.push(JSON.parse(String(init?.body ?? '{}')))
        return Response.json({ id: `m-${sends.length}` })
      }
      if (href.includes('/settings/sendAs')) return Response.json({ sendAs: [] })
      return Response.json({}, { status: 404 })
    }) as typeof fetch
  })

  after(async () => {
    globalThis.fetch = realFetch
    if (ids.workspace) await prisma.workspace.deleteMany({ where: { id: ids.workspace } })
    await prisma.member.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.deleteMany({ where: { id: ids.org } })
    await prisma.user.deleteMany({ where: { id: `owner-${suffix}` } })
    await prisma.inboundEvent.deleteMany({ where: { externalId: { contains: suffix } } })
  })

  const mail = {
    to: ['jane@customer.test'],
    subject: `Your refund ${suffix}`,
    body: 'It is on its way.',
  }

  /**
   * Sam sends the mail, as its runner asks on its connection (a new one, unless given): what that
   * connection hears of this call.
   */
  async function send(on?: Awaited<ReturnType<typeof connect>>) {
    const conn = on ?? (await connect())
    const callId = randomUUID()
    void conn.say({
      type: 'connector.call',
      callId,
      sessionId: ids.session,
      teammateId: ids.sam,
      connectionId: ids.gmail,
      operation: 'gmail_send',
      input: mail,
    })
    return {
      conn,
      get heard() {
        return conn.sent.filter((m) => m.callId === callId)
      },
    }
  }
  const pendingOf = async (call: { heard: Sent[] }) => {
    await until(() => call.heard.some((m) => m.type === 'connector.pending'), 'the call to wait')
    return call.heard.find((m) => m.type === 'connector.pending')!.ticketId as string
  }
  /** As a restart of the workspace's hub leaves it: no tool waits on a connection any more. */
  const forgetWaiters = async () => {
    const { forgetWaiters } = await import('../src/held-calls.js')
    const { localHub } = await import('../src/hub/memory-host.js')
    const { inHub } = await import('../src/hub/context.js')
    const hub = localHub(scope.workspaceId)
    inHub(hub, forgetWaiters)
  }

  test('a decision after an API restart: the write is made once, and the thread hears it', async () => {
    const { decideTicket } = await import('../src/connector-calls.js')
    const before = sends.length
    const call = await send()
    const ticketId = await pendingOf(call)
    const held = await db.heldCall.findFirstOrThrow({ where: { ticketId } })
    assert.equal(held.status, 'waiting')
    assert.equal(held.kind, 'connector')

    // The API restarts: nothing waits for the decision in its hub any more.
    await forgetWaiters()
    assert.equal(
      await decideTicket({ ...scope, memberId: ids.owner }, ticketId, { approved: true }),
      true,
    )
    await until(
      async () => (await db.heldCall.findFirst({ where: { ticketId } }))?.status === 'done',
      'the held call to be made',
    )
    assert.equal(sends.length - before, 1, 'sent once')
    const calls = await db.connectionCall.findMany({ where: { ticketId } })
    assert.deepEqual(
      calls.map((c) => c.result),
      ['ok'],
    )
    // The runner never heard: the thread does, as a message for Sam.
    assert.equal(
      call.heard.filter((m) => m.type === 'connector.result').length,
      0,
      'no tool waits for it',
    )
    const wakeup = await db.wakeup.findFirstOrThrow({ where: { sourceId: `held:${ticketId}` } })
    assert.equal(wakeup.kind, 'reply')
    assert.equal(wakeup.teammateId, ids.sam)
    assert.match(wakeup.note, /approved/)
    assert.match(wakeup.note, /do not make it again/)
    assert.match(wakeup.note, /m-\d+/, 'with its result')

    // Deciding again does nothing more.
    assert.equal(
      await decideTicket({ ...scope, memberId: ids.owner }, ticketId, { approved: true }),
      false,
    )
    const { settleHeldCalls } = await import('../src/held-calls.js')
    await settleHeldCalls()
    assert.equal(sends.length - before, 1)
  })

  test('a decision the restart caught before the call was made: the tick makes it, once', async () => {
    const { decideTicket } = await import('../src/connector-calls.js')
    const { settleHeldCalls } = await import('../src/held-calls.js')
    const before = sends.length
    const call = await send()
    const ticketId = await pendingOf(call)
    await forgetWaiters()
    // Decided, and the API stopped before it made the call (as decideTicket leaves it then).
    await db.heldCall.updateMany({
      where: { ticketId },
      data: {
        status: 'decided',
        decision: { approved: true, memberId: ids.owner },
        updatedAt: new Date(Date.now() - 5 * 60_000),
      },
    })
    await db.ticket.updateMany({ where: { id: ticketId }, data: { status: 'approved' } })
    await settleHeldCalls()
    assert.equal((await db.heldCall.findFirstOrThrow({ where: { ticketId } })).status, 'done')
    assert.equal(sends.length - before, 1)
    await settleHeldCalls()
    assert.equal(sends.length - before, 1, 'never twice')
    void decideTicket
  })

  test('one cut off while it was made is not made again: the thread is told to check', async () => {
    const { settleHeldCalls } = await import('../src/held-calls.js')
    const before = sends.length
    const call = await send()
    const ticketId = await pendingOf(call)
    await forgetWaiters()
    await db.heldCall.updateMany({
      where: { ticketId },
      data: {
        status: 'running',
        decision: { approved: true, memberId: ids.owner },
        updatedAt: new Date(Date.now() - 20 * 60_000),
      },
    })
    await settleHeldCalls()
    assert.equal(sends.length, before, 'not sent again')
    const wakeup = await db.wakeup.findFirstOrThrow({ where: { sourceId: `held:${ticketId}` } })
    assert.match(wakeup.note, /may or may not have gone through/)
  })

  test('the same call again while its ticket is open joins it: one card, one send, both hear', async () => {
    const { decideTicket } = await import('../src/connector-calls.js')
    const before = sends.length
    const tickets = await db.ticket.count({ where: { sessionId: ids.session } })
    // The first call's connection drops (another takes over); the teammate calls again, as told.
    const one = await send()
    const ticketId = await pendingOf(one)
    const again = await connect()
    const two = await send(again)
    assert.equal(await pendingOf(two), ticketId, 'the same ticket')
    // And a third at the same moment as a fourth: still one ticket.
    const three = await send(again)
    const four = await send(again)
    assert.equal(await pendingOf(three), ticketId)
    assert.equal(await pendingOf(four), ticketId)
    assert.equal(await db.ticket.count({ where: { sessionId: ids.session } }), tickets + 1)

    await decideTicket({ ...scope, memberId: ids.owner }, ticketId, { approved: true })
    await until(
      () => [two, three, four].every((c) => c.heard.some((m) => m.type === 'connector.result')),
      'the result',
    )
    assert.equal(sends.length - before, 1, 'one mail')
    for (const call of [two, three, four]) {
      const result = call.heard.find((m) => m.type === 'connector.result')
      assert.equal(result?.ok, true)
      assert.deepEqual(result?.decision, { ticketId, approved: true, memberId: ids.owner })
    }
    assert.equal(
      one.heard.filter((m) => m.type === 'connector.result').length,
      0,
      'its socket is gone',
    )
    // Tools heard it: no message in the thread for it.
    assert.equal(await db.wakeup.count({ where: { sourceId: `held:${ticketId}` } }), 0)
  })

  test('a denial after a restart: nothing is sent, and the thread hears why', async () => {
    const { decideTicket } = await import('../src/connector-calls.js')
    const before = sends.length
    const call = await send()
    const ticketId = await pendingOf(call)
    await forgetWaiters()
    await decideTicket({ ...scope, memberId: ids.owner }, ticketId, {
      approved: false,
      reason: 'Not this customer',
    })
    await until(
      async () => (await db.heldCall.findFirst({ where: { ticketId } }))?.status === 'done',
      'the denial to be taken',
    )
    assert.equal(sends.length, before)
    const wakeup = await db.wakeup.findFirstOrThrow({ where: { sourceId: `held:${ticketId}` } })
    assert.match(wakeup.note, /denied/)
    assert.match(wakeup.note, /Not this customer/)
  })

  // -------------------------------------------------------------------------
  // Commands for runners
  // -------------------------------------------------------------------------

  const hello = (protocolVersion = OUTBOX_PROTOCOL) =>
    JSON.stringify({ type: 'hello', protocolVersion, version: '0.0.0', platform: 'linux-x64' })
  const queuedCommand = () => ({
    type: 'thread.queued' as const,
    commandId: randomUUID(),
    sessionId: ids.session,
    messageId: `msg-${randomUUID()}`,
    action: 'cancel' as const,
    memberId: ids.owner,
  })
  /** The workspace's hub, its operations bound. */
  const hubOf = async () => {
    const { hubs } = await import('../src/hub.js')
    const hub = hubs.get(scope.workspaceId)
    return { dispatch: hub.dispatch.bind(hub) }
  }
  /** A runner connecting with this protocol: its socket and what it is sent. */
  async function connect(protocolVersion = OUTBOX_PROTOCOL) {
    const { runnerSocket } = await import('../src/hub.js')
    const handle = runnerSocket({ id: ids.runner, computerId: ids.laptop, ...scope })
    const { sent, ws } = socket()
    handle.onMessage(hello(protocolVersion), ws as never)
    await until(() => sent.some((m) => m.type === 'welcome'), 'the welcome')
    const say = (message: object) => handle.onMessage(JSON.stringify(message), ws as never)
    return { handle, sent, say }
  }

  test('a command not acknowledged is sent again after a reconnect, and not once acknowledged', async () => {
    const { dispatch } = await hubOf()
    const first = await connect()
    const command = queuedCommand()
    assert.equal(await dispatch({ id: ids.laptop, kind: 'member_machine' }, command), 'sent')
    assert.ok(
      first.sent.some((m) => m.commandId === command.commandId),
      'sent at once',
    )
    // Its connection dies before it acknowledged it.
    first.handle.onClose()
    const second = await connect()
    await until(
      () => second.sent.some((m) => m.commandId === command.commandId),
      'the command sent again',
    )
    const replayed = second.sent.find((m) => m.commandId === command.commandId)!
    assert.ok(
      second.sent.indexOf(replayed) > second.sent.findIndex((m) => m.type === 'welcome'),
      'after the welcome',
    )
    // Acknowledged now (the runner had seen it, and says so again).
    second.say({ type: 'command.ack', commandIds: [command.commandId] })
    await until(
      async () =>
        (await prisma.runnerCommand.findUnique({ where: { id: command.commandId } }))?.status ===
        'acked',
      'the ack',
    )
    second.handle.onClose()
    const third = await connect()
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(third.sent.filter((m) => m.commandId === command.commandId).length, 0)
    third.handle.onClose()
  })

  test('a runner too old to acknowledge takes each command once, as before', async () => {
    const { dispatch } = await hubOf()
    const old = await connect(OUTBOX_PROTOCOL - 1)
    const command = queuedCommand()
    await dispatch({ id: ids.laptop, kind: 'member_machine' }, command)
    assert.equal(old.sent.filter((m) => m.commandId === command.commandId).length, 1)
    assert.equal(
      (await prisma.runnerCommand.findUniqueOrThrow({ where: { id: command.commandId } })).status,
      'acked',
    )
    old.handle.onClose()
    const again = await connect(OUTBOX_PROTOCOL - 1)
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(again.sent.filter((m) => m.commandId === command.commandId).length, 0)
    again.handle.onClose()
  })

  test("a kept command goes with its thread's latest arrival, and not once the thread left", async () => {
    const { dispatch } = await hubOf()
    const { ThreadSpec } = await import('@brigade/contracts')
    const thread = ThreadSpec.parse({
      sessionId: ids.session,
      teammate: { id: ids.sam, name: 'Sam', instructions: '', harness: 'claude_code', model: null },
      permissionMode: 'allow-all',
      account: { id: 'a', provider: 'claude_code', source: 'brigade' },
      fallbacks: [],
    })
    const command = {
      type: 'thread.retry' as const,
      commandId: randomUUID(),
      thread,
      memberId: ids.owner,
    }
    const first = await connect()
    await dispatch({ id: ids.laptop, kind: 'member_machine' }, command)
    first.handle.onClose()

    // Its computer replaced meanwhile: the thread arrived on it again, its events numbered on.
    const movedAt = new Date()
    await prisma.session.update({
      where: { id: ids.session },
      data: { movedAt, movedFrom: 'the cloud computer this one replaced', movedSeq: 40 },
    })
    const second = await connect()
    await until(() => second.sent.some((m) => m.commandId === command.commandId), 'sent again')
    const sent = second.sent.find((m) => m.commandId === command.commandId) as {
      thread: { moved?: { at: string; seq: number } }
    }
    assert.equal(sent.thread.moved?.at, movedAt.toISOString())
    assert.equal(sent.thread.moved?.seq, 40)
    second.handle.onClose()

    // The thread went to another computer: it is not sent here any more.
    await prisma.session.update({ where: { id: ids.session }, data: { computerId: ids.cloud } })
    try {
      const third = await connect()
      await new Promise((resolve) => setTimeout(resolve, 100))
      assert.equal(third.sent.filter((m) => m.commandId === command.commandId).length, 0)
      assert.equal(
        (await prisma.runnerCommand.findUniqueOrThrow({ where: { id: command.commandId } })).status,
        'expired',
      )
      // Its events from here are acknowledged, never stored: the runner stops sending them.
      third.say({
        type: 'events',
        events: [
          {
            sessionId: ids.session,
            seq: 3,
            event: { at: new Date().toISOString(), type: 'raw', source: 'runner', value: 'x' },
          },
        ],
      })
      await until(
        () => third.sent.some((m) => m.type === 'ack' && m.seq === 3),
        'the acknowledgement',
      )
      third.handle.onClose()
    } finally {
      await prisma.session.update({
        where: { id: ids.session },
        data: { computerId: ids.laptop, movedAt: null, movedFrom: null, movedSeq: null },
      })
    }
  })

  test('a cloud computer that takes over 10 minutes to start still gets its commands', async () => {
    const { dispatch } = await hubOf()
    const { runnerSocket } = await import('../src/hub.js')
    const { resendCommands } = await import('../src/runner-commands.js')
    const command = { ...queuedCommand() }
    assert.equal(await dispatch({ id: ids.cloud, kind: 'cloud' }, command), 'queued')
    // Fifteen minutes later, across an API restart: the row is all there is.
    await prisma.runnerCommand.updateMany({
      where: { id: command.commandId },
      data: { createdAt: new Date(Date.now() - 15 * 60_000) },
    })
    await resendCommands()
    const runner = await db.runner.create({
      data: { computerId: ids.cloud, tokenHash: `cloud-${suffix}` },
    } as never)
    const handle = runnerSocket({ id: runner.id, computerId: ids.cloud, ...scope })
    const { sent, ws } = socket()
    handle.onMessage(hello(), ws as never)
    await until(() => sent.some((m) => m.commandId === command.commandId), 'the command')
    handle.onClose()
  })

  test('a command not through in 24 hours opens a ticket in its thread', async () => {
    const { dispatch } = await hubOf()
    const { giveUp } = await import('../src/runner-commands.js')
    const command = queuedCommand()
    await dispatch({ id: ids.cloud, kind: 'cloud' }, command)
    await prisma.runnerCommand.updateMany({
      where: { id: command.commandId },
      data: { createdAt: new Date(Date.now() - 25 * 60 * 60_000) },
    })
    await giveUp()
    assert.equal(
      (await prisma.runnerCommand.findUniqueOrThrow({ where: { id: command.commandId } })).status,
      'failed',
    )
    const ticket = await db.ticket.findFirstOrThrow({
      where: { sessionId: ids.session, payload: { path: ['undelivered'], equals: true } },
    })
    assert.match(ticket.title, /Not delivered: a change to a queued message/)
  })

  /** A thread on the cloud computer, stopped: what is sent to it waits. */
  async function cloudThread() {
    const session = await db.session.create({
      data: {
        teammateId: ids.sam,
        startedByMemberId: ids.owner,
        computerId: ids.cloud,
        title: 'Alerts',
        status: 'idle',
      } as never,
    })
    const { ThreadSpec } = await import('@brigade/contracts')
    const spec = ThreadSpec.parse({
      sessionId: session.id,
      teammate: { id: ids.sam, name: 'Sam', instructions: '', harness: 'claude_code', model: null },
      permissionMode: 'allow-all',
      account: { id: 'a', provider: 'claude_code', source: 'brigade' },
      fallbacks: [],
    })
    /** A message nobody typed: an event's, a wake-up's. */
    const automatic = (text: string) => ({
      type: 'thread.prompt' as const,
      commandId: randomUUID(),
      thread: spec,
      text,
      memberId: null,
      then: [],
      attachments: [],
    })
    return { sessionId: session.id, automatic }
  }

  test('commands past the caps on a computer that stays down are refused, and counted', async () => {
    const { dispatch } = await hubOf()
    const { failuresOf } = await import('../src/ops/failures.js')
    const { PENDING_PER_THREAD, AUTOMATIC_PER_COMPUTER } = await import('../src/runner-commands.js')
    const cloud = { id: ids.cloud, kind: 'cloud', ...scope }
    await prisma.runnerCommand.deleteMany({ where: { computerId: ids.cloud } })
    // A person's commands to one thread: past PENDING_PER_THREAD, refused.
    for (let i = 0; i < PENDING_PER_THREAD; i++)
      assert.equal(await dispatch(cloud, queuedCommand()), 'queued')
    const refusedBefore = failuresOf('runner-outbox', 60_000).length
    await assert.rejects(dispatch(cloud, queuedCommand()), (error: unknown) => {
      assert.equal((error as { status?: number }).status, 503)
      assert.match((error as Error).message, /commands already wait for this thread/)
      return true
    })
    assert.equal(failuresOf('runner-outbox', 60_000).length, refusedBefore + 1)
    await prisma.runnerCommand.deleteMany({ where: { computerId: ids.cloud } })

    // Messages from events, each to a thread of its own: past AUTOMATIC_PER_COMPUTER, refused.
    const threads = []
    for (let i = 0; i < AUTOMATIC_PER_COMPUTER; i++) {
      const thread = await cloudThread()
      threads.push(thread.sessionId)
      assert.equal(await dispatch(cloud, thread.automatic(`Alert ${i}`)), 'queued')
    }
    const one = await cloudThread()
    threads.push(one.sessionId)
    await assert.rejects(dispatch(cloud, one.automatic('One too many')), /from events/)
    // A person's message still goes.
    assert.equal(await dispatch(cloud, queuedCommand()), 'queued')
    await prisma.runnerCommand.deleteMany({ where: { computerId: ids.cloud } })
    await prisma.session.deleteMany({ where: { id: { in: threads } } })
  })

  // -------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------

  test('a GitHub delivery kept before a restart is processed by the tick, once', async () => {
    const { githubWebhook } = await import('../src/routes/github-webhook.js')
    const { processDueInbound } = await import('../src/inbound.js')
    const installation = 9_000_000 + Math.floor(Math.random() * 1_000_000)
    const github = await db.connection.create({
      data: {
        kind: 'github',
        label: 'acme',
        externalAccount: 'acme',
        externalUrl: `https://github.com/settings/installations/${installation}`,
        createdByMemberId: ids.owner,
        appId: (
          await db.app.create({ data: { key: 'github', createdByMemberId: ids.owner } as never })
        ).id,
      } as never,
    })
    // Kept by the route, then the API stopped before processing it.
    const delivery = `delivery-${suffix}`
    await prisma.inboundEvent.create({
      data: {
        source: 'github',
        externalId: delivery,
        type: 'installation',
        payload: { action: 'suspend', installation: { id: installation } },
      },
    })
    await processDueInbound()
    assert.equal(
      (await db.connection.findFirstOrThrow({ where: { id: github.id } })).status,
      'needs_reauth',
    )
    const kept = await prisma.inboundEvent.findFirstOrThrow({ where: { externalId: delivery } })
    assert.deepEqual([kept.status, kept.attempts], ['done', 1])

    // GitHub sends it again (asked for again): recognised, not processed twice.
    await db.connection.updateMany({ where: { id: github.id }, data: { status: 'active' } })
    const body = JSON.stringify({ action: 'suspend', installation: { id: installation } })
    const post = (id: string) =>
      githubWebhook.request('/', {
        method: 'POST',
        body,
        headers: {
          'x-github-event': 'installation',
          'x-github-delivery': id,
          'x-hub-signature-256': `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`,
        },
      })
    assert.equal((await post(delivery)).status, 200)
    await processDueInbound()
    assert.equal(
      (await db.connection.findFirstOrThrow({ where: { id: github.id } })).status,
      'active',
    )
    // A new delivery through the route: kept, answered, processed.
    const fresh = `fresh-${suffix}`
    assert.equal((await post(fresh)).status, 202)
    await until(
      async () =>
        (await prisma.inboundEvent.findFirst({ where: { externalId: fresh } }))?.status === 'done',
      'the delivery to be processed',
    )
    assert.equal(
      (await db.connection.findFirstOrThrow({ where: { id: github.id } })).status,
      'needs_reauth',
    )
  })

  test('concurrent tries of one event start one thread; a try a crash cut off is taken over', async () => {
    const { deliver } = await import('../src/triggers.js')
    const app = await db.app.create({
      data: { key: 'webhook', createdByMemberId: ids.owner } as never,
    })
    const connection = await db.connection.create({
      data: {
        appId: app.id,
        kind: 'webhook',
        label: 'Sentry',
        createdByMemberId: ids.owner,
      } as never,
    })
    const row = await db.trigger.create({
      data: {
        connectionId: connection.id,
        teammateId: ids.sam,
        label: 'Errors',
        event: 'received',
        createdByMemberId: ids.owner,
        pathToken: `token-${suffix}`,
      } as never,
    })
    const trigger = await prisma.trigger.findUniqueOrThrow({
      where: { id: row.id },
      include: { teammate: true, connection: true },
    })
    const event = (eventId: string) => ({
      eventId,
      eventType: 'received',
      title: 'Errors: TypeError',
      text: 'TypeError in checkout',
    })
    const results = await Promise.all([1, 2, 3].map(() => deliver(trigger, event('evt-1'))))
    assert.equal(results.filter((r) => 'ok' in r).length, 1, JSON.stringify(results))
    // The others found it being started: not done, so their senders try again.
    assert.equal(results.filter((r) => 'error' in r || 'duplicate' in r).length, 2)
    assert.equal(await db.session.count({ where: { triggerId: trigger.id } }), 1)
    // Again later (the sender's retry): where it went.
    const again = await deliver(trigger, event('evt-1'))
    assert.ok('duplicate' in again && again.threadId)

    // A try that crashed between its claim and its thread: while its claim is fresh, a retry is
    // not taken as done (the inbox tries again); once stale, it is taken over.
    const { dispatch } = await import('../src/triggers.js')
    await db.triggerDelivery.create({
      data: { triggerId: trigger.id, eventId: 'evt-2', status: 'starting' } as never,
    })
    const busy = await dispatch(
      trigger.connection,
      { id: 'evt-2', type: 'received', payload: {} },
      trigger,
    )
    assert.equal(busy.failed, true, 'tried again later, not taken as delivered')
    assert.equal(busy.started, 0)
    await db.triggerDelivery.updateMany({
      where: { triggerId: trigger.id, eventId: 'evt-2' },
      data: { updatedAt: new Date(Date.now() - 30 * 60_000) },
    })
    const taken = await deliver(trigger, event('evt-2'))
    assert.ok('ok' in taken, JSON.stringify(taken))
    assert.equal(await db.session.count({ where: { triggerId: trigger.id } }), 2)

    // A try that crashed after its thread started, before it settled: taken over, it goes on in
    // that thread, and its first message reaches the computer once.
    const first = await deliver(trigger, event('evt-3'))
    assert.ok('ok' in first)
    const claim = await db.triggerDelivery.findFirstOrThrow({
      where: { triggerId: trigger.id, eventId: 'evt-3' },
    })
    assert.equal(claim.threadId, first.threadId)
    await db.triggerDelivery.updateMany({
      where: { id: claim.id },
      data: { status: 'starting', updatedAt: new Date(Date.now() - 30 * 60_000) },
    })
    const retaken = await deliver(trigger, event('evt-3'))
    assert.deepEqual(retaken, { ok: true, threadId: first.threadId, paused: false })
    assert.equal(await db.session.count({ where: { triggerId: trigger.id } }), 3)
    assert.equal(await prisma.runnerCommand.count({ where: { id: `delivery:${claim.id}` } }), 1)
    assert.equal(
      await prisma.runnerCommand.count({
        where: { sessionId: first.threadId, type: 'thread.prompt' },
      }),
      1,
      'one first message',
    )

    // Cut off after its thread was made, before its first message was kept: the thread's id was
    // chosen with the claim, so the next try takes that thread up and sends its message, once.
    // A mailbox's rule that may start 4 threads a day, its 4th being this one: the thread the
    // cut-off try made does not count against it twice.
    trigger.options = { perDay: '4' }
    const made = await deliver(trigger, { ...event('evt-4'), mailbox: true })
    assert.ok('ok' in made)
    const claim4 = await db.triggerDelivery.findFirstOrThrow({
      where: { triggerId: trigger.id, eventId: 'evt-4' },
    })
    await prisma.runnerCommand.deleteMany({ where: { id: `delivery:${claim4.id}` } })
    await db.triggerDelivery.updateMany({
      where: { id: claim4.id },
      data: { status: 'starting', updatedAt: new Date(Date.now() - 30 * 60_000) },
    })
    const resumed = await deliver(trigger, { ...event('evt-4'), mailbox: true })
    trigger.options = {}
    assert.deepEqual(resumed, { ok: true, threadId: made.threadId, paused: false })
    assert.equal(await db.session.count({ where: { triggerId: trigger.id } }), 4)
    assert.equal(await prisma.runnerCommand.count({ where: { id: `delivery:${claim4.id}` } }), 1)

    // Held by a cap, then cut off: the next try is held by the same card, never past the cap.
    await db.teammate.updateMany({ where: { id: ids.sam }, data: { caps: { threadsPerDay: 0 } } })
    try {
      const capped = await deliver(trigger, event('evt-5'))
      assert.ok('ok' in capped && capped.paused, JSON.stringify(capped))
      const claim5 = await db.triggerDelivery.findFirstOrThrow({
        where: { triggerId: trigger.id, eventId: 'evt-5' },
      })
      await db.triggerDelivery.updateMany({
        where: { id: claim5.id },
        data: { status: 'starting', updatedAt: new Date(Date.now() - 30 * 60_000) },
      })
      const again5 = await deliver(trigger, event('evt-5'))
      assert.deepEqual(again5, { ok: true, threadId: capped.threadId, paused: true })
      assert.equal(await prisma.runnerCommand.count({ where: { id: `delivery:${claim5.id}` } }), 0)
      assert.equal(
        await db.ticket.count({
          where: { sessionId: capped.threadId, type: 'cap', status: 'open' },
        }),
        1,
      )
    } finally {
      await db.teammate.updateMany({ where: { id: ids.sam }, data: { caps: {} } })
    }
  })

  test('a wake-up fired again after a restart cut it off reaches its thread once', async () => {
    const { fireDueWakeups } = await import('../src/wakeups.js')
    const runner = await connect()
    const wakeup = await db.wakeup.create({
      data: {
        sessionId: ids.session,
        teammateId: ids.sam,
        kind: 'reply',
        note: 'A reply came',
        wakeAt: new Date(Date.now() - 1000),
      } as never,
    })
    await fireDueWakeups()
    const fired = await db.wakeup.findFirstOrThrow({ where: { id: wakeup.id } })
    assert.equal(fired.status, 'fired')
    assert.equal(await prisma.runnerCommand.count({ where: { id: `wakeup:${wakeup.id}` } }), 1)
    // As if the API stopped after keeping its prompt, before settling it: fired again.
    await db.wakeup.updateMany({
      where: { id: wakeup.id },
      data: { status: 'pending', firedAt: null },
    })
    await fireDueWakeups()
    assert.equal((await db.wakeup.findFirstOrThrow({ where: { id: wakeup.id } })).status, 'fired')
    assert.equal(
      await prisma.runnerCommand.count({
        where: {
          sessionId: ids.session,
          type: 'thread.prompt',
          message: { path: ['text'], equals: 'A reply came' },
        },
      }),
      1,
      'one prompt',
    )
    assert.equal(runner.sent.filter((m) => m.commandId === `wakeup:${wakeup.id}`).length, 1)
    runner.handle.onClose()
  })

  test('a call cut off whose thread could not be told is told on a later tick', async () => {
    const { settleHeldCalls } = await import('../src/held-calls.js')
    const ticket = await db.ticket.create({
      data: {
        sessionId: ids.session,
        type: 'approval',
        title: 'Sam: gmail send (cut)',
        status: 'approved',
      },
    } as never)
    const held = await db.heldCall.create({
      data: {
        sessionId: ids.session,
        // Nobody to tell yet: telling the thread fails.
        teammateId: 'no-such-teammate',
        ticketId: ticket.id,
        kind: 'connector',
        fingerprint: ticket.id,
        request: {},
        status: 'running',
        decision: { approved: true, memberId: ids.owner },
      } as never,
    })
    const stale = () =>
      db.heldCall.updateMany({
        where: { id: held.id },
        data: { updatedAt: new Date(Date.now() - 20 * 60_000) },
      })
    await stale()
    await settleHeldCalls()
    assert.equal((await db.heldCall.findFirstOrThrow({ where: { id: held.id } })).status, 'running')
    await db.heldCall.updateMany({ where: { id: held.id }, data: { teammateId: ids.sam } })
    await stale()
    await settleHeldCalls()
    assert.equal((await db.heldCall.findFirstOrThrow({ where: { id: held.id } })).status, 'done')
    assert.equal(await db.wakeup.count({ where: { sourceId: `held:${ticket.id}` } }), 1)
  })

  test('a wake-up a cap holds, fired again after a restart, opens one card and goes once', async () => {
    const { fireDueWakeups } = await import('../src/wakeups.js')
    const { resolveTicket } = await import('../src/decide.js')
    const runner = await connect()
    await db.teammate.updateMany({
      where: { id: ids.sam },
      data: { caps: { computerHoursPerDay: 0 } },
    })
    try {
      const wakeup = await db.wakeup.create({
        data: {
          sessionId: ids.session,
          teammateId: ids.sam,
          kind: 'reply',
          note: 'capped reply',
          wakeAt: new Date(Date.now() - 1000),
        } as never,
      })
      await fireDueWakeups()
      await db.wakeup.updateMany({
        where: { id: wakeup.id },
        data: { status: 'pending', firedAt: null },
      })
      await fireDueWakeups()
      const cards = await db.ticket.findMany({
        where: {
          sessionId: ids.session,
          type: 'cap',
          status: 'open',
          payload: { path: ['pending', 'commandId'], equals: `wakeup:${wakeup.id}` },
        },
      })
      assert.equal(cards.length, 1, JSON.stringify(cards.map((c) => [c.title, c.payload])))
      assert.equal(
        await db.ticket.count({
          where: {
            sessionId: ids.session,
            type: 'cap',
            payload: { path: ['pending', 'text'], equals: 'capped reply' },
          },
        }),
        1,
        'no second card for the same prompt',
      )
      await resolveTicket(
        { ...scope, memberId: ids.owner, userId: `owner-${suffix}`, role: 'owner' },
        cards[0]!.id,
        { approved: true },
      )
      assert.equal(runner.sent.filter((m) => m.commandId === `wakeup:${wakeup.id}`).length, 1)
      // Fired again once more: it went already.
      await db.wakeup.updateMany({
        where: { id: wakeup.id },
        data: { status: 'pending', firedAt: null },
      })
      await fireDueWakeups()
      assert.equal(runner.sent.filter((m) => m.commandId === `wakeup:${wakeup.id}`).length, 1)
    } finally {
      await db.teammate.updateMany({ where: { id: ids.sam }, data: { caps: {} } })
      runner.handle.onClose()
    }
  })

  test("a playbook's delivery cut off after its run began takes that run up, counted once", async () => {
    const { beginRun } = await import('../src/playbooks.js')
    const { deliver } = await import('../src/triggers.js')
    const installation = await db.playbookInstallation.create({
      data: {
        playbookKey: 'test/durable',
        version: '1.0.0',
        manifest: {
          id: 'test/durable',
          version: '1.0.0',
          name: 'Durable',
          limits: { runsPerDay: 1 },
          apps: [],
          actions: [],
          settings: [],
          entries: [],
          skills: [],
        },
        teammateId: ids.sam,
        ownerMemberId: ids.owner,
        status: 'active',
        createdByMemberId: ids.owner,
      } as never,
    })
    const app =
      (await db.app.findFirst({ where: { key: 'webhook' } })) ??
      (await db.app.create({ data: { key: 'webhook', createdByMemberId: ids.owner } as never }))
    const connection = await db.connection.create({
      data: { appId: app.id, kind: 'webhook', label: 'Run', createdByMemberId: ids.owner } as never,
    })
    const row = await db.trigger.create({
      data: {
        connectionId: connection.id,
        teammateId: ids.sam,
        label: 'Run',
        event: 'received',
        createdByMemberId: ids.owner,
        pathToken: `orphan-${suffix}`,
        playbookInstallationId: installation.id,
      } as never,
    })
    // A try claimed the event and began its run (the day's only one), then the API stopped
    // before its thread was made.
    const threadId = randomUUID()
    await db.triggerDelivery.create({
      data: {
        triggerId: row.id,
        eventId: 'orphan-event',
        threadId,
        status: 'starting',
        updatedAt: new Date(Date.now() - 30 * 60_000),
      } as never,
    })
    assert.ok('runId' in (await beginRun(db, installation.id, undefined, `run-${threadId}`)))
    const trigger = await prisma.trigger.findUniqueOrThrow({
      where: { id: row.id },
      include: { teammate: true, connection: true },
    })
    const outcome = await deliver(trigger, {
      eventId: 'orphan-event',
      eventType: 'received',
      title: 'Resume',
      text: 'Resume this work',
    })
    assert.deepEqual(outcome, { ok: true, threadId, paused: false })
    assert.equal(await db.playbookRun.count({ where: { installationId: installation.id } }), 1)
    assert.equal(
      (await db.session.findFirstOrThrow({ where: { id: threadId } })).playbookRunId,
      `run-${threadId}`,
    )
  })
  test("a playbook's delivery whose thread failed, cut off before its run was let go, counts one run", async () => {
    const { beginRun } = await import('../src/playbooks.js')
    const { deliver } = await import('../src/triggers.js')
    const installation = await db.playbookInstallation.create({
      data: {
        playbookKey: 'test/durable-failed',
        version: '1.0.0',
        manifest: {
          id: 'test/durable',
          version: '1.0.0',
          name: 'Durable',
          limits: { runsPerDay: 1 },
          apps: [],
          actions: [],
          settings: [],
          entries: [],
          skills: [],
        },
        teammateId: ids.sam,
        ownerMemberId: ids.owner,
        status: 'active',
        createdByMemberId: ids.owner,
      } as never,
    })
    const app =
      (await db.app.findFirst({ where: { key: 'webhook' } })) ??
      (await db.app.create({ data: { key: 'webhook', createdByMemberId: ids.owner } as never }))
    const connection = await db.connection.create({
      data: { appId: app.id, kind: 'webhook', label: 'Run', createdByMemberId: ids.owner } as never,
    })
    const row = await db.trigger.create({
      data: {
        connectionId: connection.id,
        teammateId: ids.sam,
        label: 'Run',
        event: 'received',
        createdByMemberId: ids.owner,
        pathToken: `failed-${suffix}`,
        playbookInstallationId: installation.id,
      } as never,
    })
    // A try claimed the event and began its run (the day's only one), then the API stopped
    // before its thread was made.
    const threadId = randomUUID()
    await db.triggerDelivery.create({
      data: {
        triggerId: row.id,
        eventId: 'failed-event',
        threadId,
        status: 'starting',
        updatedAt: new Date(Date.now() - 30 * 60_000),
      } as never,
    })
    assert.ok('runId' in (await beginRun(db, installation.id, undefined, `run-${threadId}`)))
    // Its thread was made, its first prompt failed, and the API stopped after marking it failed,
    // before its run was let go.
    await db.session.create({
      data: {
        id: threadId,
        teammateId: ids.sam,
        startedByMemberId: ids.owner,
        computerId: ids.cloud,
        title: 'Failed first prompt',
        status: 'failed',
        playbookRunId: `run-${threadId}`,
        origin: 'trigger',
        triggerId: row.id,
      } as never,
    })
    const trigger = await prisma.trigger.findUniqueOrThrow({
      where: { id: row.id },
      include: { teammate: true, connection: true },
    })
    const outcome = await deliver(trigger, {
      eventId: 'failed-event',
      eventType: 'received',
      title: 'Resume',
      text: 'Resume this work',
    })
    // A new thread, and its run the only one of the day.
    assert.ok('ok' in outcome && outcome.threadId !== threadId, JSON.stringify(outcome))
    const runs = await db.playbookRun.findMany({ where: { installationId: installation.id } })
    assert.deepEqual(
      runs.map((r) => r.id),
      [`run-${outcome.threadId}`],
    )
  })
})
