import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, beforeEach, describe, test } from 'node:test'
import { parseEnv } from 'node:util'
import { OUTBOX_PROTOCOL, type SequencedEvent } from '@brigade/contracts'

// What production did not say on 2026-10-27, and what piled up meanwhile:
// - an account whose turns fail for want of a login is marked needs_sign_in after two in a row,
//   never for a usage or rate limit, and a turn that worked starts the count again;
// - threads whose events wait unacknowledged, and commands piling up for a computer, alert;
// - Brigade's own alert emails never start or feed a trigger's thread, other automatic mail does;
// - a trigger's events for a thread whose computer cannot take them are one prompt, not one each.
// The rules without a database; the rest against the API's development database (apps/api/.env),
// in an organization of its own removed at the end, skipped when no database answers.
const envFile = new URL('../.env', import.meta.url)
if (!process.env.DATABASE_URL && existsSync(envFile))
  process.env.DATABASE_URL = parseEnv(readFileSync(envFile, 'utf8')).DATABASE_URL
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
delete process.env.OPS_ALERT_WEBHOOK_URL
delete process.env.OPS_ALERT_EMAILS

const { prisma, scoped } = await import('../src/db.js')
const { signedOut, noteAccountState, clearAccountHealth, SIGN_IN_AFTER } =
  await import('../src/account-health.js')
const { isOwnAlert, alertsAddress } = await import('../src/ops/alerts.js')
const {
  RULES,
  eventsWaitingProblems,
  backlogMatters,
  backlogProblem,
  BACKLOG_AGE_MS,
  BACKLOG_COUNT,
} = await import('../src/ops/checks.js')
const { failuresOf, clearFailures } = await import('../src/ops/failures.js')
const { alertSubject } = await import('../src/ops/send.js')
const database = await Promise.race([
  prisma.$queryRaw`select 1`.then(() => true),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
]).catch(() => false)

const MIN = 60_000

describe('a login that stopped working, by what harnesses say', () => {
  test("Claude Code's and Codex's refusals, and an API's 401", () => {
    for (const message of [
      'Not logged in · Please run /login',
      'Invalid API key · Please run /login',
      'OAuth token has expired. Please obtain a new token or refresh your existing token.',
      'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}',
      'Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.',
      'unexpected status 401 Unauthorized: Provided authentication token is expired. Please try signing in again.',
    ])
      assert.ok(signedOut(message), message)
  })

  test('never a usage or rate limit, nor any error that only mentions a credential', () => {
    for (const message of [
      'Claude AI usage limit reached|1793095200',
      "You've hit your usage limit. Upgrade to Pro or try again later.",
      'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Too many requests"}}',
      'Credit balance is too low',
      'API Error: 529 Overloaded',
      'The Stripe credential was refused by the App',
      'Claude Code process exited with code 1',
      'fetch failed: 401 from https://api.github.com (the GitHub App)',
    ])
      assert.ok(!signedOut(message), message)
  })

  test('operators hear of each account marked, once per incident', () => {
    const rule = RULES.find((r) => r.kind === 'account-signed-out')
    assert.ok(rule)
    assert.equal(rule.warning, 1)
  })
})

describe("Brigade's own alert emails", () => {
  const notice = {
    kind: 'firing' as const,
    key: 'computer:c1',
    severity: 'critical' as const,
    title: 'Cloud computer down: Box',
    detail: '',
    firstAt: new Date(),
    at: new Date(),
  }

  test('from the alerts address, or relayed automatic with their subject', () => {
    assert.ok(isOwnAlert({ from: `Brigade alerts <${alertsAddress()}>`, subject: 'Hi' }))
    assert.ok(isOwnAlert({ from: alertsAddress().toUpperCase(), subject: 'Hi' }))
    assert.ok(
      isOwnAlert({
        from: 'Ops list <ops@acme.test>',
        subject: alertSubject(notice),
        automatic: true,
      }),
    )
    assert.ok(
      isOwnAlert({
        from: 'ops@acme.test',
        subject: alertSubject({ ...notice, kind: 'resolved', severity: 'warning' }),
        automatic: true,
      }),
    )
  })

  test("other automatic mail is not: triggers watch receipts and notifications; nor a person's", () => {
    assert.ok(
      !isOwnAlert({ from: 'Stripe <receipts@stripe.com>', subject: 'Receipt', automatic: true }),
    )
    assert.ok(
      !isOwnAlert({
        from: 'GitHub <notifications@github.com>',
        subject: '[acme/app] Run failed',
        automatic: true,
      }),
    )
    // A person forwarding one by hand writes to the teammate: theirs to send.
    assert.ok(
      !isOwnAlert({
        from: 'ada@acme.test',
        subject: `Fwd: ${alertSubject(notice)}`,
        automatic: false,
      }),
    )
    assert.ok(!isOwnAlert({}))
  })
})

describe('alerts on what waits', () => {
  const now = Date.parse('2026-10-27T12:00:00Z')
  const ago = (ms: number) => new Date(now - ms).toISOString()

  test('events unacknowledged for 10 minutes alert, by computer; 30, critical', () => {
    const names = new Map([['c1', 'Box (Acme, c1)']])
    assert.deepEqual(
      eventsWaitingProblems(
        [{ sessionId: 's1', computerId: 'c1', since: ago(4 * MIN) }],
        names,
        now,
      ),
      [],
    )
    const [alert, ...others] = eventsWaitingProblems(
      [
        { sessionId: 's1', computerId: 'c1', since: ago(12 * MIN) },
        { sessionId: 's2', computerId: 'c1', since: ago(40 * MIN) },
        { sessionId: 's3', computerId: 'c2', since: ago(MIN) },
      ],
      names,
      now,
    )
    assert.equal(others.length, 0)
    assert.equal(alert!.key, 'events-waiting:c1')
    assert.equal(alert!.severity, 'critical')
    assert.match(alert!.title, /Box \(Acme, c1\)/)
    assert.match(alert!.detail!, /2 thread\(s\)/)
  })

  test('a backlog of commands: by count, or by the age of the oldest', () => {
    const computer = {
      id: 'c1',
      name: 'Box',
      kind: 'cloud',
      status: 'stopped',
      updatedAt: new Date(now),
      workspace: { name: 'Acme' },
    }
    const at = (ms: number) => new Date(now - ms)
    assert.equal(backlogProblem(computer, { count: 3, oldest: at(5 * MIN) }, now), null)
    assert.equal(
      backlogProblem(computer, { count: BACKLOG_COUNT, oldest: at(MIN) }, now)?.severity,
      'warning',
    )
    assert.equal(
      backlogProblem(computer, { count: 1, oldest: at(BACKLOG_AGE_MS) }, now)?.key,
      'backlog:c1',
    )
    assert.equal(
      backlogProblem(computer, { count: 53, oldest: at(4 * 60 * MIN) }, now)?.severity,
      'critical',
    )
    // A laptop asleep keeps what was sent to it: no backlog; awake with one waiting, it is.
    assert.equal(backlogMatters({ kind: 'member_machine' }, false), false)
    assert.equal(backlogMatters({ kind: 'member_machine' }, true), true)
    assert.equal(backlogMatters({ kind: 'cloud' }, false), true)
  })
})

describe('against the database', { skip: !database && 'no database answers' }, () => {
  const suffix = randomUUID().slice(0, 8)
  const ids = {} as Record<
    'org' | 'workspace' | 'owner' | 'laptop' | 'cloud' | 'runner' | 'teammate' | 'account',
    string
  >
  let db: ReturnType<typeof scoped>
  let scope: { organizationId: string; workspaceId: string }

  before(async () => {
    ids.org = `org-guards-${suffix}`
    await prisma.organization.create({
      data: { id: ids.org, name: 'Guards', slug: `guards-${suffix}` },
    })
    await prisma.user.create({
      data: { id: `owner-${suffix}`, name: 'Ada', email: `guards-${suffix}@test.local` },
    })
    ids.owner = `m-guards-${suffix}`
    await prisma.member.create({
      data: { id: ids.owner, organizationId: ids.org, userId: `owner-${suffix}`, role: 'owner' },
    })
    ids.workspace = (
      await prisma.workspace.create({ data: { organizationId: ids.org, name: 'Guards' } })
    ).id
    scope = { organizationId: ids.org, workspaceId: ids.workspace }
    db = scoped(scope)
    ids.laptop = (
      await db.computer.create({
        data: { kind: 'member_machine', memberId: ids.owner, name: 'Laptop', status: 'running' },
      } as never)
    ).id
    // Down, as the incident's was: what is sent to it waits.
    ids.cloud = (
      await db.computer.create({
        data: { kind: 'cloud', name: 'Cloud', status: 'stopped' },
      } as never)
    ).id
    ids.runner = (
      await db.runner.create({
        data: { computerId: ids.laptop, tokenHash: `guards-${suffix}` },
      } as never)
    ).id
    for (const computerId of [ids.cloud, ids.laptop]) {
      const account = await db.account.create({
        data: {
          memberId: ids.owner,
          computerId,
          provider: 'claude_code',
          label: `Claude ${suffix}`,
          status: 'ready',
        },
      } as never)
      if (computerId === ids.laptop) ids.account = account.id
    }
    ids.teammate = (await db.teammate.create({ data: { name: `Riley ${suffix}` } } as never)).id
  })

  after(async () => {
    if (ids.workspace) await prisma.workspace.deleteMany({ where: { id: ids.workspace } })
    await prisma.member.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.deleteMany({ where: { id: ids.org } })
    await prisma.user.deleteMany({ where: { id: `owner-${suffix}` } })
  })

  beforeEach(() => {
    clearFailures()
    clearAccountHealth()
  })

  async function thread() {
    return db.session.create({
      data: {
        teammateId: ids.teammate,
        startedByMemberId: ids.owner,
        computerId: ids.laptop,
        accountId: ids.account,
        title: 'Work',
        status: 'running',
      } as never,
    })
  }
  const at = new Date().toISOString()
  /** A turn on the account: started, then what the harness said. */
  const turn = (sessionId: string, seq: number, ...said: object[]): SequencedEvent[] =>
    [
      { at, type: 'turn.started', teammateId: ids.teammate, accountId: ids.account },
      ...said.map((e) => ({ at, ...e })),
    ].map((event, i) => ({ sessionId, seq: seq + i, event }) as unknown as SequencedEvent)
  const NOT_LOGGED_IN = 'Not logged in · Please run /login'
  const refused = [
    { type: 'message.done', id: 'm', text: NOT_LOGGED_IN },
    { type: 'error', message: NOT_LOGGED_IN },
  ]
  const account = () => prisma.account.findUniqueOrThrow({ where: { id: ids.account } })
  const signInTickets = () =>
    prisma.ticket.count({
      where: {
        type: 'sign_in',
        status: 'open',
        payload: { path: ['accountId'], equals: ids.account },
      },
    })
  const reset = async () => {
    await prisma.account.update({ where: { id: ids.account }, data: { status: 'ready' } })
    await prisma.ticket.deleteMany({ where: { workspaceId: ids.workspace, type: 'sign_in' } })
  }

  test(`${SIGN_IN_AFTER} turns in a row failing signed out mark the account, once`, async () => {
    await reset()
    const session = await thread()
    const first = turn(session.id, 1, ...refused)
    await noteAccountState(session, first)
    // Noted again (a retry of the same run): still one failure.
    await noteAccountState(session, first)
    assert.equal((await account()).status, 'ready', 'one failure is not enough')
    assert.equal(await signInTickets(), 0)

    await noteAccountState(session, turn(session.id, 4, ...refused))
    assert.equal((await account()).status, 'needs_sign_in')
    assert.equal(await signInTickets(), 1, 'its member is told (ticket, push)')
    const told = failuresOf('account-signed-out', 60 * MIN)
    assert.equal(told.length, 1)
    assert.equal(told[0]!.workspaceId, ids.workspace)
    assert.match(told[0]!.message, /Not logged in/)

    // A third failure, or the second noted again: nothing more.
    await noteAccountState(session, turn(session.id, 7, ...refused))
    await noteAccountState(session, turn(session.id, 4, ...refused))
    assert.equal(failuresOf('account-signed-out', 60 * MIN).length, 1)
    assert.equal(await signInTickets(), 1)

    // Signed in again, a turn that worked makes it ready.
    await noteAccountState(
      session,
      turn(session.id, 10, { type: 'message.done', id: 'm2', text: 'Done.' }),
    )
    assert.equal((await account()).status, 'ready')
  })

  test('a turn that worked between two failures starts the count again', async () => {
    await reset()
    const session = await thread()
    await noteAccountState(session, turn(session.id, 1, ...refused))
    await noteAccountState(
      session,
      turn(session.id, 4, { type: 'message.done', id: 'm', text: 'Hi' }),
    )
    await noteAccountState(session, turn(session.id, 6, ...refused))
    assert.equal((await account()).status, 'ready')
    await noteAccountState(session, turn(session.id, 9, ...refused))
    assert.equal((await account()).status, 'needs_sign_in')
  })

  test('usage and rate limits never mark it', async () => {
    await reset()
    const session = await thread()
    for (const [i, message] of [
      'Claude AI usage limit reached|1793095200',
      'API Error: 429 rate_limit_error: Too many requests',
      'Credit balance is too low',
    ].entries())
      await noteAccountState(session, turn(session.id, 1 + 2 * i, { type: 'error', message }))
    assert.equal((await account()).status, 'ready')
    assert.equal(failuresOf('account-signed-out', 60 * MIN).length, 0)
  })

  test("an error in a later run than its turn's start is that turn's account's", async () => {
    await reset()
    const session = await thread()
    // Another account started the thread; this turn runs on ours, its start stored earlier.
    const other = await prisma.account.findFirstOrThrow({
      where: { workspaceId: ids.workspace, computerId: ids.cloud },
    })
    await prisma.session.update({ where: { id: session.id }, data: { accountId: other.id } })
    for (const seq of [1, 3]) {
      await prisma.sessionEvent.create({
        data: {
          ...scope,
          sessionId: session.id,
          seq,
          type: 'turn.started',
          data: { at, type: 'turn.started', teammateId: ids.teammate, accountId: ids.account },
          at: new Date(),
        },
      })
      await noteAccountState({ ...session, accountId: other.id }, [
        {
          sessionId: session.id,
          seq: seq + 1,
          event: { at, type: 'error', message: NOT_LOGGED_IN },
        } as SequencedEvent,
      ])
    }
    assert.equal((await account()).status, 'needs_sign_in')
    assert.equal(
      (await prisma.account.findUniqueOrThrow({ where: { id: other.id } })).status,
      'ready',
    )
  })

  test('a reply after a switch out of usage mid-turn is the new account’s, not the spent one’s', async () => {
    await reset()
    const session = await thread()
    const other = await prisma.account.findFirstOrThrow({
      where: { workspaceId: ids.workspace, computerId: ids.cloud },
    })
    const until = new Date(Date.now() + 60 * MIN)
    await prisma.account.update({ where: { id: ids.account }, data: { exhaustedUntil: until } })
    await prisma.account.update({ where: { id: other.id }, data: { status: 'needs_sign_in' } })
    const stored = [
      { at, type: 'turn.started', teammateId: ids.teammate, accountId: ids.account },
      {
        at,
        type: 'account.switched',
        fromAccountId: ids.account,
        toAccountId: other.id,
        reason: 'usage_limit',
        resetsAt: until.toISOString(),
      },
    ]
    for (const [i, data] of stored.entries())
      await prisma.sessionEvent.create({
        data: {
          ...scope,
          sessionId: session.id,
          seq: i + 1,
          type: data.type,
          data,
          at: new Date(),
        },
      })
    await noteAccountState(session, [
      {
        sessionId: session.id,
        seq: 3,
        event: { at, type: 'message.done', id: 'm', text: 'Done.' },
      } as SequencedEvent,
    ])
    const spent = await account()
    assert.equal(spent.exhaustedUntil?.getTime(), until.getTime(), 'still out of usage')
    assert.equal(
      (await prisma.account.findUniqueOrThrow({ where: { id: other.id } })).status,
      'ready',
    )
    await prisma.account.update({ where: { id: ids.account }, data: { exhaustedUntil: null } })
  })

  test('a thread whose events wait 10 minutes, as its runner says, alerts', async () => {
    const { hubs, runnerSocket } = await import('../src/hub.js')
    const hub = hubs.get(scope.workspaceId)
    let waitingNow: { sessionId: string; computerId: string; since: string }[] = []
    const threadsWaiting = () => waitingNow
    const look = async () => {
      waitingNow = await hub.threadsWaiting()
    }
    const session = await thread()
    const handle = runnerSocket({ id: ids.runner, computerId: ids.laptop, ...scope })
    const sent: { type: string }[] = []
    const ws = { send: (raw: string) => sent.push(JSON.parse(raw)), close: () => {} }
    const say = (message: object) => handle.onMessage(JSON.stringify(message), ws as never)
    try {
      say({
        type: 'hello',
        protocolVersion: OUTBOX_PROTOCOL,
        version: '0.0.0',
        platform: 'linux-x64',
      })
      for (let i = 0; i < 200 && !sent.some((m) => m.type === 'welcome'); i++)
        await new Promise((resolve) => setTimeout(resolve, 20))
      const since = new Date(Date.now() - 15 * MIN).toISOString()
      say({ type: 'events.waiting', threads: [{ sessionId: session.id, since }] })
      for (let i = 0; i < 200 && !threadsWaiting().some((w) => w.sessionId === session.id); i++) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        await look()
      }
      const waiting = threadsWaiting().filter((w) => w.computerId === ids.laptop)
      assert.deepEqual(waiting, [{ sessionId: session.id, computerId: ids.laptop, since }])
      const [alert] = eventsWaitingProblems(waiting, new Map(), Date.now())
      assert.equal(alert?.key, `events-waiting:${ids.laptop}`)
      // Through: the runner lists it no more.
      say({ type: 'events.waiting', threads: [] })
      for (let i = 0; i < 200 && threadsWaiting().some((w) => w.sessionId === session.id); i++) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        await look()
      }
      assert.equal(threadsWaiting().filter((w) => w.computerId === ids.laptop).length, 0)

      // Its computer stopped, or its runner went silent: forgotten with it, not alerting for as
      // long as the computer stays off.
      say({ type: 'events.waiting', threads: [{ sessionId: session.id, since }] })
      for (let i = 0; i < 200 && !threadsWaiting().some((w) => w.sessionId === session.id); i++) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        await look()
      }
      await hub.dropRunner(ids.laptop)
      await look()
      assert.equal(threadsWaiting().filter((w) => w.computerId === ids.laptop).length, 0)
    } finally {
      handle.onClose()
    }
  })

  /** A trigger on a custom app's URL, with the conversation each event names. */
  async function trigger(label: string) {
    const app =
      (await db.app.findFirst({ where: { key: 'webhook' } })) ??
      (await db.app.create({ data: { key: 'webhook', createdByMemberId: ids.owner } as never }))
    const connection = await db.connection.create({
      data: { appId: app.id, kind: 'webhook', label, createdByMemberId: ids.owner } as never,
    })
    const row = await db.trigger.create({
      data: {
        connectionId: connection.id,
        teammateId: ids.teammate,
        label,
        event: 'received',
        createdByMemberId: ids.owner,
        pathToken: `${label}-${suffix}`,
      } as never,
    })
    return prisma.trigger.findUniqueOrThrow({
      where: { id: row.id },
      include: { teammate: true, connection: true },
    })
  }

  test("Brigade's own alert mail is no trigger's, a receipt or a custom app's JSON is", async () => {
    const { dispatch, ownAlertMail } = await import('../src/triggers.js')
    const alert = {
      payload: {
        from: `Brigade alerts <${alertsAddress()}>`,
        subject: '[Brigade critical] Cloud computer down',
        automatic: true,
      },
    }
    assert.equal(ownAlertMail({ kind: 'email' }, alert), true)
    assert.equal(ownAlertMail({ kind: 'gmail' }, alert), true)
    // A custom app's JSON that happens to look like one is not mail.
    assert.equal(ownAlertMail({ kind: 'webhook' }, alert), false)
    assert.equal(
      ownAlertMail(
        { kind: 'email' },
        { payload: { from: 'Stripe <receipts@stripe.com>', subject: 'Receipt', automatic: true } },
      ),
      false,
    )
    // Through a custom app's trigger, such JSON starts its thread.
    const t = await trigger('mail')
    const json = await dispatch(t.connection, { id: `json-${suffix}`, type: 'received', ...alert })
    assert.equal(json.started, 1)
    assert.equal(await db.session.count({ where: { triggerId: t.id } }), 1)
  })

  test("a trigger's events for a computer that is down each wait, counted by the backlog check", async () => {
    const { deliver } = await import('../src/triggers.js')
    const { computersWaiting } = await import('../src/runner-commands.js')
    const t = await trigger('errors')
    const event = (n: number) => ({
      eventId: `evt-${n}-${suffix}`,
      eventType: 'received',
      title: `Errors: ${n}`,
      text: `TypeError number ${n}`,
      conversationKey: `conv-${suffix}`,
    })
    const results = []
    for (const n of [1, 2, 3]) results.push(await deliver(t, event(n)))
    assert.ok(results.every((r) => 'ok' in r && r.threadId === results[0]!.threadId))
    const threadId = (results[0] as { threadId: string }).threadId
    // Every event is kept, and goes as a prompt of its own, in order, once the computer is back.
    const commands = await prisma.runnerCommand.findMany({
      where: { sessionId: threadId, type: 'thread.prompt' },
      orderBy: { createdAt: 'asc' },
    })
    assert.deepEqual(
      commands.map((c) => [c.status, (c.message as { text: string }).text]),
      [1, 2, 3].map((n) => ['pending', `TypeError number ${n}`]),
    )
    const pending = (await computersWaiting()).find((w) => w.computerId === ids.cloud)
    assert.equal(
      pending?._count._all,
      await prisma.runnerCommand.count({ where: { computerId: ids.cloud, status: 'pending' } }),
    )
  })
})
