import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'

// A playbook's numbers, from a week of runs made by hand, and the first response timed by a real
// call. On the API's development database (apps/api/.env), in a workspace of its own removed at
// the end; skipped when none answers.
const envFile = new URL('../.env', import.meta.url)
if (!process.env.DATABASE_URL && existsSync(envFile))
  process.env.DATABASE_URL = parseEnv(readFileSync(envFile, 'utf8')).DATABASE_URL
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')

const { prisma, scoped } = await import('../src/db.js')
const { templates } = await import('../src/playbooks.js')
const database = await Promise.race([
  prisma.$queryRaw`select 1`.then(() => true),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
]).catch(() => false)

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
/** Support and bugs as shipped: its first response is its reply. */
const MANIFEST = templates().get('brigade/support-bugs')!.manifest

after(() => prisma.$disconnect())

describe('a playbook’s numbers', { skip: !database && 'no database answers' }, () => {
  const suffix = randomUUID().slice(0, 8)
  const ids = {} as Record<
    'org' | 'workspace' | 'owner' | 'other' | 'computer' | 'teammate' | 'installation',
    string
  >
  let db: ReturnType<typeof scoped>
  let scope: { organizationId: string; workspaceId: string }
  const now = new Date()
  const ago = (ms: number) => new Date(now.getTime() - ms)

  before(async () => {
    ids.org = `org-${suffix}`
    await prisma.organization.create({
      data: { id: ids.org, name: 'Metrics', slug: `metrics-${suffix}` },
    })
    for (const who of ['owner', 'other'] as const) {
      await prisma.user.create({
        data: { id: `${who}-${suffix}`, name: who, email: `${who}-${suffix}@test.local` },
      })
      ids[who] = `m-${who}-${suffix}`
      await prisma.member.create({
        data: { id: ids[who], organizationId: ids.org, userId: `${who}-${suffix}`, role: 'member' },
      })
    }
    ids.workspace = (
      await prisma.workspace.create({ data: { organizationId: ids.org, name: 'Metrics' } })
    ).id
    scope = { organizationId: ids.org, workspaceId: ids.workspace }
    db = scoped(scope)
    ids.computer = (await db.computer.create({ data: { kind: 'cloud', name: 'Test' } as never })).id
    ids.teammate = (await db.teammate.create({ data: { name: 'Sam' } as never })).id
    ids.installation = await install('active')
  })

  after(async () => {
    if (ids.workspace) await prisma.workspace.deleteMany({ where: { id: ids.workspace } })
    await prisma.member.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.deleteMany({ where: { id: ids.org } })
    await prisma.user.deleteMany({
      where: { id: { in: ['owner', 'other'].map((w) => `${w}-${suffix}`) } },
    })
  })

  async function install(status: 'active' | 'paused') {
    const installation = await db.playbookInstallation.create({
      data: {
        playbookKey: MANIFEST.id,
        version: MANIFEST.version,
        manifest: MANIFEST,
        teammateId: ids.teammate,
        ownerMemberId: ids.owner,
        settings: {},
        status,
        createdByMemberId: ids.owner,
      } as never,
    })
    await db.playbookAction.createMany({
      data: MANIFEST.actions.map((a) => ({
        installationId: installation.id,
        key: a.key,
        level: a.start,
      })) as never,
    })
    return installation.id
  }

  let seq = 0
  /** A thread of a run, with one turn of `minutes` (none: no turn). */
  async function thread(
    runId: string,
    input: { minutes?: number; parentId?: string; origin?: string; at?: Date } = {},
  ) {
    const session = await db.session.create({
      data: {
        teammateId: ids.teammate,
        startedByMemberId: ids.owner,
        computerId: ids.computer,
        title: 'Mail',
        origin: input.origin ?? (input.parentId ? 'child' : 'trigger'),
        playbookRunId: runId,
        ...(input.parentId ? { parentId: input.parentId } : {}),
      } as never,
    })
    if (input.minutes !== undefined) {
      const at = input.at ?? ago(DAY)
      await db.sessionEvent.createMany({
        data: [
          { sessionId: session.id, seq: ++seq, type: 'turn.started', data: {}, at },
          {
            sessionId: session.id,
            seq: ++seq,
            type: 'turn.completed',
            data: {},
            at: new Date(at.getTime() + input.minutes * MINUTE),
          },
        ] as never,
      })
    }
    return session.id
  }

  /** A run started `startedAgo`, its root thread made and tied to it. */
  async function run(
    startedAgo: number,
    data: {
      case?: string
      outcome?: string
      ended?: boolean
      interventions?: number
      responseAfter?: number
      dryRun?: boolean
      installationId?: string
      origin?: string
      minutes?: number
    } = {},
  ) {
    const startedAt = ago(startedAgo)
    const row = await db.playbookRun.create({
      data: {
        installationId: data.installationId ?? ids.installation,
        case: data.case ?? null,
        outcome: data.outcome ?? null,
        status: data.ended ? 'done' : 'running',
        interventions: data.interventions ?? 0,
        dryRun: data.dryRun ?? false,
        startedAt,
        endedAt: data.ended ? new Date(startedAt.getTime() + 90 * MINUTE) : null,
        firstResponseAt:
          data.responseAfter === undefined
            ? null
            : new Date(startedAt.getTime() + data.responseAfter * MINUTE),
      } as never,
    })
    const root = await thread(row.id, {
      ...(data.minutes !== undefined ? { minutes: data.minutes } : {}),
      ...(data.origin ? { origin: data.origin } : {}),
    })
    await db.playbookRun.updateMany({ where: { id: row.id }, data: { rootSessionId: root } })
    return { id: row.id, root }
  }

  /** A ticket in a thread a person decided. */
  const decided = (
    sessionId: string,
    who: 'owner' | 'other',
    status: 'approved' | 'denied',
    payload: Record<string, unknown> = {},
  ) =>
    db.ticket.create({
      data: {
        sessionId,
        type: 'approval',
        status,
        title: 'Sam: gmail send',
        resolvedByMemberId: ids[who],
        resolvedAt: now,
        payload: {
          playbookInstallationId: ids.installation,
          playbookActionKey: 'reply',
          ...payload,
        },
      } as never,
    })

  const pull = (sessionId: string, number: number, state: 'merged' | 'closed' | 'open') =>
    db.pullRequest.create({
      data: {
        repository: 'acme/web',
        number,
        title: `Fix ${number}`,
        headRef: `fix-${number}`,
        baseRef: 'main',
        sessionId,
        state,
        ...(state === 'merged' ? { mergedAt: now } : {}),
      } as never,
    })

  test('a hand-made week: this week, the week before and by case, without dry runs', async () => {
    // This week. A documented question answered on its own in 10 minutes; Brigade's proposal to
    // let replies go on their own, decided in its thread, is about the playbook, not this run.
    const r1 = await run(2 * DAY, {
      case: 'documented_question',
      outcome: 'resolved',
      ended: true,
      responseAfter: 10,
      minutes: 5,
    })
    await decided(r1.root, 'owner', 'approved', {
      playbookPromotion: { installationId: ids.installation, actionKey: 'reply' },
    })
    // The same case in other capitals: its reply approved by the owner, sent after 30 minutes.
    const r2 = await run(3 * DAY, {
      case: 'Documented_Question',
      outcome: 'resolved',
      ended: true,
      responseAfter: 30,
    })
    await decided(r2.root, 'owner', 'approved')
    // A bug escalated after a member wrote in it; its child thread worked too.
    const r3 = await run(4 * DAY, {
      case: 'bug',
      outcome: 'escalated',
      ended: true,
      interventions: 1,
      minutes: 2,
    })
    await thread(r3.id, { parentId: r3.root, minutes: 3 })
    // A bug fixed: one pull request merged, one closed; another member denied a write.
    const r4 = await run(5 * DAY, { case: 'bug', outcome: 'resolved', ended: true })
    const child = await thread(r4.id, { parentId: r4.root })
    await pull(child, 1, 'merged')
    await pull(r4.root, 2, 'closed')
    await decided(r4.root, 'other', 'denied')
    // Still running, no case yet; and the weekly review, from its schedule.
    await run(60 * MINUTE)
    await run(6 * DAY, { outcome: 'resolved', ended: true, origin: 'schedule' })

    // A dry run this week counts nowhere, whatever happened in it.
    const dry = await run(DAY, {
      case: 'bug',
      outcome: 'escalated',
      ended: true,
      interventions: 3,
      responseAfter: 1,
      dryRun: true,
      minutes: 100,
    })
    await decided(dry.root, 'owner', 'denied')
    await pull(dry.root, 3, 'merged')

    // The week before: one on its own, answered in an hour; one a member wrote in twice.
    await run(9 * DAY, {
      case: 'documented_question',
      outcome: 'resolved',
      ended: true,
      responseAfter: 60,
    })
    await run(10 * DAY, { case: 'bug', outcome: 'resolved', ended: true, interventions: 2 })
    // Older than two weeks: not read.
    await run(20 * DAY, { case: 'bug', outcome: 'escalated', ended: true })

    const { playbookMetrics } = await import('../src/playbook-metrics.js')
    const metrics = await playbookMetrics(db, { id: ids.installation, manifest: MANIFEST }, now)
    assert.deepEqual([metrics.responds, metrics.fixesBugs], [true, true])
    assert.deepEqual(metrics.week, {
      runs: 6,
      finished: 5,
      // r1 and the weekly review, of the five that ended.
      unattended: 2 / 5,
      // r2's approval, r3's message, r4's denial.
      interventionsPerRun: 0.5,
      firstResponseMinutes: 20,
      escalations: 1,
      denied: 1,
      bugsFixed: 1,
      // r1's 5, r3's 2 and its child's 3.
      minutes: 10,
    })
    assert.deepEqual(metrics.lastWeek, {
      runs: 2,
      finished: 2,
      unattended: 0.5,
      interventionsPerRun: 1,
      firstResponseMinutes: 60,
      escalations: 0,
      denied: 0,
      bugsFixed: 0,
      minutes: 0,
    })
    assert.deepEqual(
      metrics.cases.map((c) => [c.case, c.runs, c.unattended, c.firstResponseMinutes]),
      [
        ['bug', 2, 0, null],
        ['documented_question', 2, 0.5, 20],
        [null, 2, 1, null],
      ],
    )
    const bug = metrics.cases[0]!
    assert.deepEqual(
      [bug.escalations, bug.denied, bug.bugsFixed, bug.minutes, bug.interventionsPerRun],
      [1, 1, 1, 5, 1],
    )

    // The sheet reads the same numbers: its status line's runs and unattended share are theirs.
    const { getInstallation } = await import('../src/playbooks.js')
    const view = await getInstallation(db, ids.installation)
    assert.equal(view.runsThisWeek, 6)
    assert.equal(view.unattended, 2 / 5)
    assert.deepEqual(view.metrics.week, metrics.week)
    assert.equal(view.recentRuns.length, 9)
  })

  test("Home's line: mails without the weekly review, handled on its own, approved by the reader", async () => {
    // A paused playbook that ran, and an active one that did not: no line for either.
    const paused = await install('paused')
    await run(DAY, { installationId: paused, outcome: 'resolved', ended: true })
    await install('active')

    const { playbookLines } = await import('../src/playbook-metrics.js')
    const { homeFor } = await import('../src/home.js')
    assert.deepEqual(await playbookLines(db, ids.owner, now), [
      {
        id: ids.installation,
        name: 'Support and bugs',
        unit: 'mail',
        // r1 to r5: the weekly review is no mail, and the dry run no run.
        count: 5,
        onItsOwn: 1,
        approvedByYou: 1,
        withPerson: 2,
      },
    ])
    // Another member approved nothing: the same runs, read by them.
    const [line] = (await homeFor(db, ids.other, now)).playbooks
    assert.deepEqual(
      [line?.count, line?.onItsOwn, line?.approvedByYou, line?.withPerson],
      [5, 1, 0, 3],
    )
  })
})

describe('the first response', { skip: !database && 'no database answers' }, () => {
  const suffix = randomUUID().slice(0, 8)
  const ids = {} as Record<
    'org' | 'workspace' | 'owner' | 'computer' | 'teammate' | 'gmail' | 'installation',
    string
  >
  let db: ReturnType<typeof scoped>
  let scope: { organizationId: string; workspaceId: string }
  const realFetch = globalThis.fetch
  /** Gmail's answers: a send fails while this is set. */
  let failing = false

  before(async () => {
    ids.org = `org-${suffix}`
    await prisma.organization.create({
      data: { id: ids.org, name: 'First response', slug: `first-response-${suffix}` },
    })
    await prisma.user.create({
      data: { id: `owner-${suffix}`, name: 'owner', email: `owner-${suffix}@test.local` },
    })
    ids.owner = `m-owner-${suffix}`
    await prisma.member.create({
      data: { id: ids.owner, organizationId: ids.org, userId: `owner-${suffix}`, role: 'owner' },
    })
    ids.workspace = (
      await prisma.workspace.create({ data: { organizationId: ids.org, name: 'First response' } })
    ).id
    scope = { organizationId: ids.org, workspaceId: ids.workspace }
    db = scoped(scope)
    ids.computer = (await db.computer.create({ data: { kind: 'cloud', name: 'Test' } as never })).id
    ids.teammate = (await db.teammate.create({ data: { name: 'Sam' } as never })).id
    const app = await db.app.create({
      data: { key: 'gmail', createdByMemberId: ids.owner } as never,
    })
    // A Google token good for an hour: the call goes out to Gmail (stubbed below).
    const { sealSecret } = await import('../src/vault.js')
    const vaultSecretId = await sealSecret(db, scope, {
      accessToken: 'token',
      refreshToken: null,
      expiresAt: Date.now() + 3600_000,
    })
    ids.gmail = (
      await db.connection.create({
        data: {
          appId: app.id,
          kind: 'gmail',
          label: 'Gmail',
          externalAccount: 'support@acme.test',
          createdByMemberId: ids.owner,
          vaultSecretId,
        } as never,
      })
    ).id
    await db.grant.create({
      data: { teammateId: ids.teammate, connectionId: ids.gmail, scope: 'read_write' } as never,
    })
    ids.installation = (
      await db.playbookInstallation.create({
        data: {
          playbookKey: MANIFEST.id,
          version: MANIFEST.version,
          manifest: MANIFEST,
          teammateId: ids.teammate,
          ownerMemberId: ids.owner,
          // Its inbox: the one Gmail account its runs may use.
          settings: { inbox: ids.gmail },
          status: 'active',
          createdByMemberId: ids.owner,
        } as never,
      })
    ).id
    await db.playbookAction.createMany({
      data: MANIFEST.actions.map((a) => ({
        installationId: ids.installation,
        key: a.key,
        level: a.start,
      })) as never,
    })
    globalThis.fetch = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname
      if (path.endsWith('/messages/send'))
        return failing
          ? Response.json({ error: { message: 'Backend Error' } }, { status: 500 })
          : Response.json({ id: 'sent-1', threadId: 'thread-1' })
      if (path.endsWith('/drafts')) return Response.json({ id: 'draft-1', message: { id: 'm-1' } })
      return Response.json({ error: { message: 'Not Found' } }, { status: 404 })
    }) as typeof fetch
  })

  after(async () => {
    globalThis.fetch = realFetch
    if (ids.workspace) await prisma.workspace.deleteMany({ where: { id: ids.workspace } })
    await prisma.member.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.deleteMany({ where: { id: ids.org } })
    await prisma.user.deleteMany({ where: { id: `owner-${suffix}` } })
  })

  /** A run and its thread; a dry run's when asked. */
  async function runThread(dryRun = false) {
    const run = await db.playbookRun.create({
      data: { installationId: ids.installation, dryRun } as never,
    })
    const session = await db.session.create({
      data: {
        teammateId: ids.teammate,
        startedByMemberId: ids.owner,
        computerId: ids.computer,
        title: 'Mail from Jane',
        origin: 'trigger',
        playbookRunId: run.id,
      } as never,
    })
    return { runId: run.id, sessionId: session.id }
  }

  /** A write from a run's thread, as its runner sends it; one that asks is approved by the owner. */
  async function write(sessionId: string, operation: string) {
    const { handleConnectorCall, decideTicket } = await import('../src/connector-calls.js')
    const { fakeRunner } = await import('./in-hub.js')
    const runner = await fakeRunner(scope, ids.computer)
    const callId = randomUUID()
    const heard = () =>
      runner.sent.filter((m) => m.callId === callId) as {
        type: string
        ticketId?: string
        ok?: boolean
        output?: unknown
      }[]
    await runner.run(() =>
      handleConnectorCall(
        { computerId: ids.computer, ...scope },
        {
          type: 'connector.call',
          callId,
          sessionId,
          connectionId: ids.gmail,
          operation,
          input: { to: ['jane@customer.test'], subject: 'Re: login', body: 'Here is how.' },
        },
        runner.reply as never,
        { live: runner.live },
      ),
    )
    const first = heard().find((m) => m.type === 'connector.pending')?.ticketId
    if (first) {
      await decideTicket({ ...scope, memberId: ids.owner }, first, { approved: true })
      for (let i = 0; i < 200 && !heard().some((m) => m.type === 'connector.result'); i++)
        await new Promise((resolve) => setTimeout(resolve, 20))
    }
    runner.close()
    return heard().at(-1)!
  }
  const responded = async (runId: string) =>
    (await db.playbookRun.findFirst({ where: { id: runId } }))?.firstResponseAt ?? null

  test('a dry run’s reply is simulated: no first response', async () => {
    const dry = await runThread(true)
    const result = await write(dry.sessionId, 'gmail_send')
    assert.equal((result.output as { simulated?: boolean }).simulated, true)
    assert.equal(await responded(dry.runId), null)
  })

  test('set once, on the first reply that went out: not on a draft, not on a failed send', async () => {
    const live = await runThread()
    // A draft is no answer to the customer.
    assert.equal((await write(live.sessionId, 'gmail_create_draft')).ok, true)
    assert.equal(await responded(live.runId), null)
    // A send Gmail refused is none either.
    failing = true
    assert.equal((await write(live.sessionId, 'gmail_send')).ok, false)
    failing = false
    assert.equal(await responded(live.runId), null)
    // The reply asks first: approved, it goes out, and times the run's first response.
    assert.equal((await write(live.sessionId, 'gmail_send')).ok, true)
    const first = await responded(live.runId)
    assert.ok(first)
    // On its own the next time: the first response stays the first.
    await db.playbookAction.updateMany({
      where: { installationId: ids.installation, key: 'reply' },
      data: { level: 'auto' },
    })
    assert.equal((await write(live.sessionId, 'gmail_send')).ok, true)
    assert.deepEqual(await responded(live.runId), first)
  })
})
