import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'
import { z } from 'zod'
import type { ScheduleOperation, SequencedEvent } from '@brigade/contracts'

// Goals (src/goals.ts, docs/goals.md) against the API's development database (apps/api/.env), in
// an organization of its own removed at the end; skipped when no database answers. The runner is a
// fake connection of the workspace's hub (in-hub.ts): what the API sends it is read back, and a
// command's measurement is answered as a runner would (goal.measured). An App is a test operation
// of Brigade's own Email connector, so a read and a write go through connector-calls as any.
// - a work goal measured by a command: proposed, approved, measured at each turn's end, relaunched
//   with nothing open, asleep while a ticket is open, done refused until the measurement confirms;
// - an outcome goal measured by an App: a ticket it sleeps on, a drift between turns that wakes it,
//   a relaunch the person's word withdraws, the account's usage window holding it, its budget
//   (sub-threads included) ending it;
// - its permissions: covered writes go without asking up to their cap, and only there.
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
type Sent = {
  type: string
  text?: string
  commandId?: string
  measureId?: string
  [k: string]: unknown
}

/** What the App answers to the measurement's read: the demos booked, as the test sets them. */
let demos = 0

describe('goals', { skip: !database && 'no database answers' }, () => {
  const suffix = randomUUID().slice(0, 8)
  const ids = {} as Record<
    'org' | 'workspace' | 'ada' | 'computer' | 'riley' | 'email' | 'account',
    string
  >
  let db: ReturnType<typeof scoped>
  let scope: { organizationId: string; workspaceId: string }
  let runner: Awaited<ReturnType<typeof import('./in-hub.js').fakeRunner>>
  const member = () => ({ ...scope, memberId: ids.ada, role: 'owner' as const })

  const thread = async (status = 'idle') => {
    const session = await db.session.create({
      data: {
        teammateId: ids.riley,
        startedByMemberId: ids.ada,
        askedByMemberId: ids.ada,
        computerId: ids.computer,
        accountId: ids.account,
        title: 'Goal',
        origin: 'member',
        status,
      } as never,
    })
    await db.threadTeammate.create({
      data: { sessionId: session.id, teammateId: ids.riley } as never,
    })
    return session
  }

  async function call(sessionId: string, operation: object): Promise<Reply> {
    const { handleScheduleCall } = await import('../src/schedules.js')
    const callId = randomUUID()
    await runner.run(() =>
      handleScheduleCall(
        { computerId: ids.computer, ...scope },
        {
          type: 'schedule.call',
          callId,
          sessionId,
          teammateId: ids.riley,
          operation: operation as ScheduleOperation,
        },
        runner.reply as never,
      ),
    )
    const result = runner.sent.find((m) => m.callId === callId && m.type === 'connector.result')
    assert.ok(result, 'the call is answered at once')
    return result as unknown as Reply
  }

  /** A turn of the thread ended: its event stored, its status idle unless said, the loop told. */
  let seq = 0
  async function turnEnds(sessionId: string, status = 'idle') {
    seq += 1
    await db.sessionEvent.create({
      data: {
        sessionId,
        seq,
        type: 'turn.completed',
        data: { type: 'turn.completed', at: new Date().toISOString() },
        at: new Date(),
      } as never,
    })
    await db.session.updateMany({
      where: { id: sessionId },
      data: { status: status as never, lastSeq: seq },
    })
    const { noteGoalTurnEnded } = await import('../src/goals.js')
    const events = [
      { sessionId, seq, event: { type: 'turn.completed', at: new Date().toISOString() } },
    ] as unknown as SequencedEvent[]
    await runner.run(() => noteGoalTurnEnded({ id: sessionId, ...scope }, events))
  }

  /** The last goal.measure sent, answered as the runner would. */
  async function answerMeasure(sessionId: string, exitCode: number, output = '') {
    const { noteMeasured } = await import('../src/goals.js')
    const asked = runner.sent.filter((m) => m.type === 'goal.measure').at(-1)
    assert.ok(asked, 'a measurement was asked of the computer')
    await runner.run(() =>
      noteMeasured(
        { computerId: ids.computer, ...scope },
        {
          type: 'goal.measured',
          measureId: asked.measureId as string,
          sessionId,
          exitCode,
          output,
        },
      ),
    )
  }

  /** Prompts sent to the thread's computer, by the kind of goal note. */
  const notes = (kind: string) =>
    runner.sent.filter(
      (m) =>
        m.type === 'thread.prompt' && typeof m.text === 'string' && m.text.includes(` · ${kind}]`),
    ) as Sent[]

  before(async () => {
    ids.org = `org-goals-${suffix}`
    await prisma.organization.create({
      data: { id: ids.org, name: 'Goals', slug: `goals-${suffix}` },
    })
    await prisma.user.create({
      data: { id: `ada-${suffix}`, name: 'Ada', email: `ada-${suffix}@test.local` },
    })
    ids.ada = `m-ada-${suffix}`
    await prisma.member.create({
      data: { id: ids.ada, organizationId: ids.org, userId: `ada-${suffix}`, role: 'owner' },
    })
    ids.workspace = (
      await prisma.workspace.create({ data: { organizationId: ids.org, name: 'Goals' } })
    ).id
    scope = { organizationId: ids.org, workspaceId: ids.workspace }
    db = scoped(scope)
    ids.computer = (
      await db.computer.create({
        data: { kind: 'member_machine', memberId: ids.ada, name: 'Laptop' } as never,
      })
    ).id
    ids.account = (
      await db.account.create({
        data: {
          memberId: ids.ada,
          computerId: ids.computer,
          provider: 'claude_code',
          label: 'Claude',
          status: 'ready',
          isDefault: true,
        } as never,
      })
    ).id
    ids.riley = (
      await db.teammate.create({
        // Every write asks a person, unless a goal allows it in advance.
        data: { name: 'Riley', permissionPolicy: { connectorWrites: 'ask' } } as never,
      })
    ).id
    const app = await db.app.create({ data: { key: 'email', createdByMemberId: ids.ada } as never })
    ids.email = (
      await db.connection.create({
        data: {
          appId: app.id,
          kind: 'email',
          label: 'Bookings',
          externalAccount: 'bookings@acme.test',
          createdByMemberId: ids.ada,
        } as never,
      })
    ).id
    await db.grant.create({
      data: { teammateId: ids.riley, connectionId: ids.email, scope: 'read_write' } as never,
    })
    // The App's read and write the goal uses, as test operations of the connector.
    const { connectors } = await import('../src/connectors/index.js')
    const ops = connectors.email!.operations as Record<string, unknown>
    ops.goal_test_demos = {
      description: 'Demos booked',
      write: false,
      input: z.object({}),
      target: () => 'demos',
      run: async () => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ booked: Array.from({ length: demos }, (_, i) => ({ id: i })) }),
          },
        ],
      }),
    }
    ops.goal_test_post = {
      description: 'Post',
      write: true,
      input: z.object({ subreddit: z.string(), text: z.string() }),
      target: (i: { subreddit: string }) => `post in r/${i.subreddit}`,
      run: async () => ({ posted: true }),
    }
    const { fakeRunner } = await import('./in-hub.js')
    runner = await fakeRunner(scope, ids.computer)
  })

  after(async () => {
    runner?.close()
    if (!database) return
    await prisma.organization.delete({ where: { id: ids.org } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: `ada-${suffix}` } })
    await prisma.$disconnect()
  })

  test('a work goal measured by a command: relaunched, asleep on a ticket, done once measured', async () => {
    const goals = await import('../src/goals.js')
    const session = await thread()
    const proposed = await call(session.id, {
      name: 'propose_goal',
      contract: {
        outcome: 'Move to the new API, tests green',
        recipe: { kind: 'command', command: 'pnpm test', read: 'exit_code', timeoutMinutes: 10 },
        budget: { tokens: 5_000_000, hours: 24 },
        stallTurns: 6,
        permissions: [],
      },
    })
    assert.equal(proposed.ok, true, proposed.error)
    const goalId = proposed.output!.goalId as string
    // Not under way until a person approves: no measurement, no note.
    assert.equal(runner.sent.filter((m) => m.type === 'goal.measure').length, 0)
    await runner.run(() => goals.approveGoal(db, member(), session, goalId))
    assert.equal((await db.goal.findFirst({ where: { id: goalId } }))!.status, 'active')
    // Measured as it starts, and the teammate told to start, as Brigade's note.
    assert.equal(runner.sent.filter((m) => m.type === 'goal.measure').length, 1)
    const start = notes('start')
    assert.equal(start.length, 1)
    assert.equal(start[0]!.memberId, null, "Brigade's note, not the person's word")
    await answerMeasure(session.id, 1, '3 failing')

    // Its done is refused while the measurement does not confirm the goal.
    const refused = await call(session.id, { name: 'complete_thread', summary: 'Migrated' })
    assert.equal(refused.ok, false)
    assert.match(refused.error!, /goal/)

    // A turn ends with nothing open: measured, still failing, relaunched with the measure.
    await turnEnds(session.id)
    assert.equal(runner.sent.filter((m) => m.type === 'goal.measure').length, 2)
    await answerMeasure(session.id, 1, '2 failing')
    const relaunches = notes('relaunch')
    assert.equal(relaunches.length, 1)
    assert.match(relaunches[0]!.text!, /not reached yet/)
    assert.match(relaunches[0]!.text!, /Turns without progress: 1 of 6/)

    // Something open (a ticket): measured, and it sleeps.
    const ticket = await db.ticket.create({
      data: {
        sessionId: session.id,
        type: 'request',
        title: 'Which staging?',
        payload: {},
      } as never,
    })
    await turnEnds(session.id, 'waiting')
    await answerMeasure(session.id, 1)
    assert.equal(notes('relaunch').length, 1, 'no relaunch while a ticket is open')
    await db.ticket.updateMany({ where: { id: ticket.id }, data: { status: 'resolved' } })

    // Idle, but waiting on the world with a wake-up of its own: it sleeps too.
    const own = await db.wakeup.create({
      data: {
        sessionId: session.id,
        teammateId: ids.riley,
        note: 'Check CI',
        wakeAt: new Date(Date.now() + 3_600_000),
      } as never,
    })
    await turnEnds(session.id)
    await answerMeasure(session.id, 1)
    assert.equal(notes('relaunch').length, 1, 'no relaunch while its own wake-up is pending')
    await db.wakeup.updateMany({ where: { id: own.id }, data: { status: 'cancelled' } })

    // The same turn's end noted twice counts once.
    const turns = (await db.goal.findFirst({ where: { id: goalId } }))!.turns
    await runner.run(() =>
      goals.noteGoalTurnEnded({ id: session.id, ...scope }, [
        { sessionId: session.id, seq, event: { type: 'turn.completed' } },
      ] as unknown as SequencedEvent[]),
    )
    assert.equal((await db.goal.findFirst({ where: { id: goalId } }))!.turns, turns)

    // The tests pass: the measurement confirms it, and the teammate is asked for its summary.
    await turnEnds(session.id)
    await answerMeasure(session.id, 0, 'all passed')
    const goal = (await db.goal.findFirst({ where: { id: goalId } }))!
    assert.equal(goal.status, 'achieved')
    assert.equal(notes('end').length, 1)
    assert.equal(notes('relaunch').length, 1, 'no relaunch once reached')
    const report = await call(session.id, {
      name: 'goal_report',
      summary: 'Tests green on the new API',
      worked: ['Migrating module by module'],
      didNotWork: [],
    })
    assert.equal(report.ok, true, report.error)
    const done = await call(session.id, {
      name: 'complete_thread',
      summary: 'Migrated, tests green',
    })
    assert.equal(done.ok, true, done.error)
  })

  test('an outcome goal measured by an App: sleeps on a ticket, drift wakes it, the person withdraws a relaunch, the budget ends it', async () => {
    const goals = await import('../src/goals.js')
    const { promptThread } = await import('../src/work.js')
    const { loadThread } = await import('../src/thread-spec.js')
    const session = await thread()
    demos = 2
    const proposed = await call(session.id, {
      name: 'propose_goal',
      contract: {
        outcome: '10 demos booked by Friday',
        deadline: new Date(Date.now() + 3 * 86_400_000).toISOString(),
        target: { comparison: 'at_least', value: 10, unit: 'demos' },
        recipe: {
          kind: 'app',
          connectionId: ids.email,
          operation: 'goal_test_demos',
          input: {},
          read: { path: 'booked', op: 'count' },
          everyMinutes: 60,
        },
        budget: { tokens: 1_000_000, hours: 96 },
        permissions: [],
      },
    })
    assert.equal(proposed.ok, true, proposed.error)
    const goalId = proposed.output!.goalId as string
    await runner.run(() => goals.approveGoal(db, member(), session, goalId))
    const first = await db.goalMeasurement.findFirst({ where: { goalId }, orderBy: { at: 'asc' } })
    assert.equal(first?.value, 2, "Brigade read the App, not the teammate's word")
    assert.equal(first?.reason, 'start')

    // It waits on a person's ticket: measured at its turn's end, not relaunched.
    const ticket = await db.ticket.create({
      data: {
        sessionId: session.id,
        type: 'request',
        title: 'Call the lead',
        payload: {},
      } as never,
    })
    demos = 4
    await turnEnds(session.id, 'waiting')
    const before = notes('relaunch').length
    assert.equal(
      (await db.goalMeasurement.findFirst({ where: { goalId }, orderBy: { at: 'desc' } }))?.value,
      4,
    )
    assert.equal(notes('relaunch').length, before, 'asleep while its ticket is open')

    // Between turns, the measurement falls: the teammate that waits is woken, once.
    demos = 1
    await db.goal.updateMany({
      where: { id: goalId },
      data: { nextMeasureAt: new Date(Date.now() - 1000) },
    })
    await runner.run(() => goals.measureDueGoals(scope.workspaceId))
    assert.equal(notes('drift').length, 1)
    assert.match(notes('drift')[0]!.text!, /from 4 demos to 1 demos/)
    await db.goal.updateMany({
      where: { id: goalId },
      data: { nextMeasureAt: new Date(Date.now() - 1000) },
    })
    demos = 0
    await runner.run(() => goals.measureDueGoals(scope.workspaceId))
    assert.equal(notes('drift').length, 1, 'at most one drift wake-up in its gap')
    await db.ticket.updateMany({ where: { id: ticket.id }, data: { status: 'resolved' } })

    // The account's usage window is nearly spent: the relaunch waits for it to reset...
    await db.account.updateMany({
      where: { id: ids.account },
      data: {
        lastUsage: [
          {
            window: '5-hour',
            utilization: 0.92,
            resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
          },
        ],
        lastUsageAt: new Date(),
      },
    })
    const relaunchesBefore = notes('relaunch').length
    await turnEnds(session.id)
    const held = (await db.goal.findFirst({ where: { id: goalId } }))!
    assert.ok(held.heldUntil && held.heldUntil > new Date(), 'held until the window resets')
    assert.equal(notes('relaunch').length, relaunchesBefore, 'not sent while held')
    const waiting = await db.wakeup.findFirst({
      where: {
        sessionId: session.id,
        status: 'pending',
        sourceId: { startsWith: `goal:${goalId}:relaunch:` },
      },
    })
    assert.ok(waiting, 'the relaunch waits as a wake-up')

    // ...and the person's word withdraws it: their turn's end decides anew.
    await runner.run(async () =>
      promptThread(db, scope, await loadThread(db, session.id), {
        text: 'Focus on the webinar list',
        memberId: ids.ada,
      }),
    )
    assert.equal((await db.wakeup.findFirst({ where: { id: waiting.id } }))!.status, 'cancelled')
    await db.account.updateMany({ where: { id: ids.account }, data: { lastUsage: [] } })

    // A relaunch decided before a person's message never goes once it is stored.
    await db.sessionEvent.create({
      data: {
        sessionId: session.id,
        seq: seq + 1,
        type: 'message.user',
        data: {
          type: 'message.user',
          text: 'and the partners',
          memberId: ids.ada,
          at: new Date().toISOString(),
        },
        at: new Date(),
      } as never,
    })
    seq += 1
    const stale = await prisma.wakeup.create({
      data: {
        ...scope,
        sessionId: session.id,
        teammateId: ids.riley,
        note: `[Brigade goal ${goalId} · relaunch]\nThe goal is not reached yet`,
        wakeAt: new Date(),
        sourceId: `goal:${goalId}:relaunch:${seq - 1}:again`,
      },
    })
    // The person's message reached the computer already: only its being after the decision holds it.
    await prisma.runnerCommand.updateMany({
      where: { sessionId: session.id, status: 'pending' },
      data: { status: 'acked' },
    })
    await db.session.updateMany({ where: { id: session.id }, data: { status: 'idle' } })
    const { fireNow } = await import('../src/wakeups.js')
    const sentBefore = runner.sent.length
    await runner.run(() => fireNow(stale.id))
    assert.equal((await db.wakeup.findFirst({ where: { id: stale.id } }))!.status, 'cancelled')
    assert.equal(
      runner.sent.slice(sentBefore).filter((m) => m.type === 'thread.prompt').length,
      0,
      'moot: the person wrote after it was decided',
    )

    // Its budget, its sub-threads' tokens included, is spent: it ends, with a summary asked.
    const child = await db.session.create({
      data: {
        teammateId: ids.riley,
        startedByMemberId: ids.ada,
        computerId: ids.computer,
        title: 'Lever: webinar',
        origin: 'child',
        parentId: session.id,
        status: 'idle',
      } as never,
    })
    for (const [sessionId, tokens] of [
      [session.id, 400_000],
      [child.id, 700_000],
    ] as const)
      await db.tokenUsage.create({
        data: {
          sessionId,
          provider: 'claude_code',
          source: 'member',
          inputTokens: tokens,
          outputTokens: 0,
          at: new Date(),
        } as never,
      })
    demos = 3
    await turnEnds(session.id)
    const ended = (await db.goal.findFirst({ where: { id: goalId } }))!
    assert.equal(ended.status, 'ended')
    assert.equal(ended.endReason, 'budget')
    assert.match(notes('end').at(-1)!.text!, /budget of tokens is spent/)
    const view = await goals.goalView(db, scope, session.id, { act: true, approve: true })
    assert.equal(view?.budget.used, 1_100_000)
    assert.equal(view?.accounts[ids.email], 'bookings@acme.test')
  })

  test('permissions: covered writes go without asking up to their cap, and only there', async () => {
    const goals = await import('../src/goals.js')
    const { handleConnectorCall } = await import('../src/connector-calls.js')

    /** A goal allowing posts in two subs, `perDay` a day, in a thread of its own. */
    const goalWith = async (perDay: number) => {
      const session = await thread()
      const proposed = await call(session.id, {
        name: 'propose_goal',
        contract: {
          outcome: '+100 stars today',
          target: { comparison: 'at_least', value: 100 },
          recipe: {
            kind: 'app',
            connectionId: ids.email,
            operation: 'goal_test_demos',
            input: {},
            read: { path: 'booked', op: 'count' },
          },
          budget: { tokens: 5_000_000, hours: 24 },
          permissions: [
            {
              connectionId: ids.email,
              operation: 'goal_test_post',
              label: `Post in 2 subs, ${perDay} a day`,
              perDay,
              onlyWhen: [{ argument: 'subreddit', oneOf: ['selfhosted', 'r/opensource'] }],
            },
          ],
        },
      })
      assert.equal(proposed.ok, true, proposed.error)
      return { session, goalId: proposed.output!.goalId as string }
    }

    /** Riley posts: answered at once (true) or held for a person (null), and the ticket then. */
    const post = async (sessionId: string, subreddit: string) => {
      const callId = randomUUID()
      await runner.run(() =>
        handleConnectorCall(
          { computerId: ids.computer, ...scope },
          {
            type: 'connector.call',
            callId,
            sessionId,
            teammateId: ids.riley,
            connectionId: ids.email,
            operation: 'goal_test_post',
            input: { subreddit, text: 'A post the person wrote' },
          },
          runner.reply as never,
          { live: runner.live },
        ),
      )
      const answer = runner.sent.find((m) => m.callId === callId && m.type === 'connector.result')
      const ticket = await db.ticket.findFirst({
        where: { sessionId, status: 'open', type: 'approval' },
        orderBy: { createdAt: 'desc' },
      })
      // Settled, so the next call is not joined to it.
      await db.ticket.updateMany({ where: { sessionId }, data: { status: 'denied' } })
      await db.heldCall.deleteMany({ where: { sessionId } })
      return { answered: (answer as Reply | undefined)?.ok ?? null, ticket }
    }

    const a = await goalWith(3)
    // Proposed, not approved: it asks.
    assert.equal((await post(a.session.id, 'selfhosted')).answered, null)
    await runner.run(() => goals.approveGoal(db, member(), a.session, a.goalId))
    assert.equal((await post(a.session.id, 'selfhosted')).answered, true)
    assert.equal(
      (await post(a.session.id, 'opensource')).answered,
      true,
      'r/ is read as the same sub',
    )
    // Outside its conditions: asks, as without the goal.
    const outside = await post(a.session.id, 'programming')
    assert.equal(outside.answered, null)
    assert.match(JSON.stringify(outside.ticket?.payload), /covers only subreddit/)
    // Withdrawn with one call left in its cap: it asks at once.
    await runner.run(() => goals.revokePermission(db, member(), a.session, a.goalId, 'p1'))
    assert.equal((await post(a.session.id, 'selfhosted')).answered, null)
    const view = await goals.goalView(db, scope, a.session.id, { act: true, approve: true })
    assert.deepEqual(view?.revoked, ['p1'])
    assert.equal(view?.usedToday.p1, 2)

    // Past its cap: a person approves.
    const b = await goalWith(1)
    await runner.run(() => goals.approveGoal(db, member(), b.session, b.goalId))
    assert.equal((await post(b.session.id, 'selfhosted')).answered, true)
    const capped = await post(b.session.id, 'selfhosted')
    assert.equal(capped.answered, null)
    assert.match(JSON.stringify(capped.ticket?.payload), /allows 1 in 24 hours/)
    // A sub-thread working on a lever is covered by its parent's goal, within the same cap.
    const lever = await db.session.create({
      data: {
        teammateId: ids.riley,
        startedByMemberId: ids.ada,
        computerId: ids.computer,
        accountId: ids.account,
        title: 'Lever',
        origin: 'child',
        parentId: b.session.id,
        status: 'running',
      } as never,
    })
    await db.threadTeammate.create({
      data: { sessionId: lever.id, teammateId: ids.riley } as never,
    })
    assert.equal((await post(lever.id, 'selfhosted')).answered, null, 'the cap is shared')

    // Paused: its permissions cover nothing.
    const c = await goalWith(5)
    await runner.run(() => goals.approveGoal(db, member(), c.session, c.goalId))
    await runner.run(() => goals.pauseGoal(db, member(), c.session, c.goalId))
    assert.equal((await post(c.session.id, 'selfhosted')).answered, null)

    // Stopped by the person: over, and no more turn for it.
    const endsBefore = notes('end').length
    await runner.run(() => goals.stopGoal(db, member(), c.session, c.goalId))
    const stopped = (await db.goal.findFirst({ where: { id: c.goalId } }))!
    assert.equal(stopped.status, 'ended')
    assert.equal(stopped.endReason, 'stopped')
    assert.equal(notes('end').length, endsBefore)
  })

  test('a contract is checked: a write it allows must be one, its measure a read, one goal at a time', async () => {
    const goals = await import('../src/goals.js')
    const session = await thread()
    demos = 0
    const base = {
      outcome: 'x',
      target: { comparison: 'at_least', value: 1 },
      recipe: {
        kind: 'app',
        connectionId: ids.email,
        operation: 'goal_test_demos',
        input: {},
        read: { path: 'booked', op: 'count' },
      },
      budget: { tokens: 1_000_000, hours: 2 },
    }
    const writeMeasure = await call(session.id, {
      name: 'propose_goal',
      contract: {
        ...base,
        recipe: { ...base.recipe, operation: 'goal_test_post' },
        permissions: [],
      },
    })
    assert.match(writeMeasure.error!, /only reads/)
    const readPermission = await call(session.id, {
      name: 'propose_goal',
      contract: {
        ...base,
        permissions: [
          { connectionId: ids.email, operation: 'goal_test_demos', label: 'Read', perDay: 5 },
        ],
      },
    })
    assert.match(readPermission.error!, /needs no permission/)
    const first = await call(session.id, {
      name: 'propose_goal',
      contract: { ...base, permissions: [] },
    })
    const second = await call(session.id, {
      name: 'propose_goal',
      contract: { ...base, permissions: [] },
    })
    assert.equal(second.ok, true, 'a new proposal replaces the one nobody decided')
    assert.equal(
      (await db.goal.findFirst({ where: { id: first.output!.goalId as string } }))!.status,
      'superseded',
    )
    await runner.run(() =>
      goals.approveGoal(db, member(), session, second.output!.goalId as string),
    )
    const third = await call(session.id, {
      name: 'propose_goal',
      contract: { ...base, permissions: [] },
    })
    assert.match(third.error!, /already under way/)
    // A sub-thread proposes none.
    const child = await db.session.create({
      data: {
        teammateId: ids.riley,
        startedByMemberId: ids.ada,
        computerId: ids.computer,
        title: 'Lever',
        origin: 'child',
        parentId: session.id,
        status: 'idle',
      } as never,
    })
    await db.threadTeammate.create({
      data: { sessionId: child.id, teammateId: ids.riley } as never,
    })
    const fromChild = await call(child.id, {
      name: 'propose_goal',
      contract: { ...base, permissions: [] },
    })
    assert.match(fromChild.error!, /at the top/)
    const status = await call(child.id, { name: 'goal_status' })
    assert.equal(status.ok, true, 'a sub-thread reads where its parent’s goal stands')
  })

  test('a goal the person judges goes on when resumed', async () => {
    const goals = await import('../src/goals.js')
    const session = await thread()
    const proposed = await call(session.id, {
      name: 'propose_goal',
      contract: {
        outcome: 'A launch post people like',
        recipe: { kind: 'person' },
        budget: { tokens: 5_000_000, hours: 24 },
        permissions: [],
      },
    })
    assert.equal(proposed.ok, true, proposed.error)
    const goalId = proposed.output!.goalId as string
    await runner.run(() => goals.approveGoal(db, member(), session, goalId))
    // Its turn's end: no figure, nothing open, relaunched.
    const before = notes('relaunch').length
    await turnEnds(session.id)
    assert.equal(notes('relaunch').length, before + 1)
    await runner.run(() => goals.pauseGoal(db, member(), session, goalId))
    await runner.run(() => goals.resumeGoal(db, member(), session, goalId))
    assert.equal(notes('relaunch').length, before + 2, 'resumed, it works again')
    const view = await goals.goalView(db, scope, session.id, { act: true, approve: true })
    assert.equal(view?.measurements.length, 0, 'no figure shows in its series')
    await runner.run(() => goals.judgeGoal(db, member(), session, goalId, true))
    assert.equal((await db.goal.findFirst({ where: { id: goalId } }))!.status, 'achieved')
  })

  test('a relaunch held for usage and cancelled by a pause is made again on resume', async () => {
    const goals = await import('../src/goals.js')
    const session = await thread()
    demos = 0
    const proposed = await call(session.id, {
      name: 'propose_goal',
      contract: {
        outcome: '5 demos',
        target: { comparison: 'at_least', value: 5 },
        recipe: {
          kind: 'app',
          connectionId: ids.email,
          operation: 'goal_test_demos',
          input: {},
          read: { path: 'booked', op: 'count' },
        },
        budget: { tokens: 5_000_000, hours: 24 },
        permissions: [],
      },
    })
    const goalId = proposed.output!.goalId as string
    await runner.run(() => goals.approveGoal(db, member(), session, goalId))
    await db.account.updateMany({
      where: { id: ids.account },
      data: {
        lastUsage: [
          {
            window: '5-hour',
            utilization: 0.95,
            resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
          },
        ],
        lastUsageAt: new Date(),
      },
    })
    await turnEnds(session.id)
    const held = await db.wakeup.findFirst({
      where: {
        sessionId: session.id,
        status: 'pending',
        sourceId: { startsWith: `goal:${goalId}:relaunch:` },
      },
    })
    assert.ok(held, 'held for usage')
    await runner.run(() => goals.pauseGoal(db, member(), session, goalId))
    assert.equal((await db.wakeup.findFirst({ where: { id: held.id } }))!.status, 'cancelled')
    await db.account.updateMany({ where: { id: ids.account }, data: { lastUsage: [] } })
    const before = notes('relaunch').length
    await runner.run(() => goals.resumeGoal(db, member(), session, goalId))
    assert.equal(
      notes('relaunch').length,
      before + 1,
      'a new relaunch, not refused as made already',
    )
    await runner.run(() => goals.stopGoal(db, member(), session, goalId))
  })

  test('what a restart stopped halfway is taken again by the minute’s job', async () => {
    const goals = await import('../src/goals.js')
    const session = await thread()
    demos = 1
    const proposed = await call(session.id, {
      name: 'propose_goal',
      contract: {
        outcome: '5 demos',
        target: { comparison: 'at_least', value: 5 },
        recipe: {
          kind: 'app',
          connectionId: ids.email,
          operation: 'goal_test_demos',
          input: {},
          read: { path: 'booked', op: 'count' },
        },
        budget: { tokens: 5_000_000, hours: 24 },
        permissions: [],
      },
    })
    const goalId = proposed.output!.goalId as string
    await runner.run(() => goals.approveGoal(db, member(), session, goalId))
    await db.goal.updateMany({
      where: { id: goalId },
      data: { nextMeasureAt: new Date(Date.now() + 3_600_000) },
    })
    // A turn's end claimed with its measurement, and the process stopped before reading the App.
    seq += 1
    await db.goal.updateMany({
      where: { id: goalId },
      data: { turnSeq: seq, turns: { increment: 1 } },
    })
    const unread = await db.goalMeasurement.create({
      data: {
        goalId,
        reason: 'turn',
        turnSeq: seq,
        at: new Date(Date.now() - 10 * 60_000),
      } as never,
    })
    const before = notes('relaunch').length
    await runner.run(() => goals.measureDueGoals(scope.workspaceId))
    const read = (await db.goalMeasurement.findFirst({ where: { id: unread.id } }))!
    assert.equal(read.value, 1, 'read then')
    assert.ok(read.handledAt)
    assert.equal(notes('relaunch').length, before + 1, 'and the loop moved on')
    // Measured, counted, and stopped before the loop moved on: moved on, its turn not counted twice.
    seq += 1
    await db.goal.updateMany({
      where: { id: goalId },
      data: { turnSeq: seq, countedSeq: seq, stalledTurns: { increment: 1 } },
    })
    const kept = await db.goalMeasurement.create({
      data: {
        goalId,
        reason: 'turn',
        turnSeq: seq,
        status: 'ok',
        value: 1,
        met: false,
        measuredAt: new Date(),
        at: new Date(Date.now() - 10 * 60_000),
      } as never,
    })
    const stalled = (await db.goal.findFirst({ where: { id: goalId } }))!.stalledTurns
    await runner.run(() => goals.measureDueGoals(scope.workspaceId))
    await runner.run(() => goals.measureDueGoals(scope.workspaceId))
    assert.ok((await db.goalMeasurement.findFirst({ where: { id: kept.id } }))!.handledAt)
    assert.equal((await db.goal.findFirst({ where: { id: goalId } }))!.stalledTurns, stalled)
    assert.equal(notes('relaunch').length, before + 2)
    await runner.run(() => goals.stopGoal(db, member(), session, goalId))
  })

  test('reading a number out of an answer', async () => {
    const { readNumber, lastNumber } = await import('../src/goals.js')
    assert.equal(
      readNumber(
        { data: [{ amount: 5 }, { amount: '7' }] },
        { path: 'data', op: 'sum', field: 'amount' },
      ),
      12,
    )
    assert.equal(readNumber('{"rows":[[3.5]]}', { path: 'rows.0.0', op: 'value' }), 3.5)
    assert.equal(readNumber({ a: 'x' }, { path: 'a', op: 'value' }), 'no number at "a"')
    assert.equal(lastNumber('Tests: 12 passed, 3 failed\n'), 3)
    assert.equal(lastNumber('nothing'), null)
  })
})
