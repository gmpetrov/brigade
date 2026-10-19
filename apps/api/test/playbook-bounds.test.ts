import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'
import type { PlaybookManifest, ScheduleOperation, TaskOperation } from '@brigade/contracts'

// What bounds a playbook's run, against the API's development database (apps/api/.env), in an
// organization of its own removed at the end; skipped when none answers:
// - the account a template names (its inbox) is the only one of that App its run may use, in the
//   tools its thread gets and when a call is made, dry runs too;
// - no task or schedule call starts or prompts a thread outside the run.
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

const MANIFEST = {
  id: 'brigade/test-bounds',
  name: 'Support',
  version: '1.0.0',
  description: 'Answers the inbox.',
  apps: [
    { kind: 'gmail', access: 'read_write' },
    { kind: 'github', access: 'read' },
  ],
  settings: [{ key: 'inbox', type: 'account', app: 'gmail' }],
  entries: [],
  skills: [],
  actions: [
    {
      key: 'reply',
      label: 'Reply to the customer',
      tools: ['gmail_send'],
      start: 'auto',
      ceiling: 'auto',
      conditions: [],
    },
  ],
  limits: { runsPerDay: 100 },
  promotion: { decisions: 30, approvedRate: 0.95 },
  metrics: [],
} satisfies PlaybookManifest

describe('the bounds of a playbook run', { skip: !database && 'no database answers' }, () => {
  const suffix = randomUUID().slice(0, 8)
  const ids = {} as Record<
    | 'org'
    | 'workspace'
    | 'owner'
    | 'computer'
    | 'teammate'
    | 'other'
    | 'support'
    | 'personal'
    | 'github'
    | 'installation'
    | 'live'
    | 'dry'
    | 'liveRun'
    | 'dryRun'
    | 'member',
    string
  >
  let db: ReturnType<typeof scoped>
  let scope: { organizationId: string; workspaceId: string }
  const runner = () => ({ computerId: ids.computer, ...scope })

  before(async () => {
    ids.org = `org-bounds-${suffix}`
    await prisma.organization.create({
      data: { id: ids.org, name: 'Bounds', slug: `bounds-${suffix}` },
    })
    await prisma.user.create({
      data: { id: `owner-${suffix}`, name: 'Ada', email: `owner-${suffix}@test.local` },
    })
    ids.owner = `m-owner-${suffix}`
    await prisma.member.create({
      data: { id: ids.owner, organizationId: ids.org, userId: `owner-${suffix}`, role: 'owner' },
    })
    ids.workspace = (
      await prisma.workspace.create({ data: { organizationId: ids.org, name: 'Bounds' } })
    ).id
    scope = { organizationId: ids.org, workspaceId: ids.workspace }
    db = scoped(scope)
    ids.computer = (
      await db.computer.create({
        data: { kind: 'member_machine', memberId: ids.owner, name: 'Laptop' } as never,
      })
    ).id
    await db.account.create({
      data: {
        memberId: ids.owner,
        computerId: ids.computer,
        provider: 'claude_code',
        label: 'Claude',
        status: 'ready',
      } as never,
    })
    ids.teammate = (await db.teammate.create({ data: { name: 'Sam' } as never })).id
    ids.other = (await db.teammate.create({ data: { name: 'Lee' } as never })).id

    // Two Gmail accounts granted to Sam: the support inbox the playbook names, and another.
    const gmail = await db.app.create({
      data: { key: 'gmail', createdByMemberId: ids.owner } as never,
    })
    const github = await db.app.create({
      data: { key: 'github', createdByMemberId: ids.owner } as never,
    })
    const connection = async (appId: string, kind: string, account: string) =>
      (
        await db.connection.create({
          data: {
            appId,
            kind,
            label: account,
            externalAccount: account,
            createdByMemberId: ids.owner,
          } as never,
        })
      ).id
    ids.support = await connection(gmail.id, 'gmail', 'support@acme.test')
    ids.personal = await connection(gmail.id, 'gmail', 'ceo@acme.test')
    ids.github = await connection(github.id, 'github', 'acme')
    for (const connectionId of [ids.support, ids.personal, ids.github])
      await db.grant.create({
        data: { teammateId: ids.teammate, connectionId, scope: 'read_write' } as never,
      })

    ids.installation = (
      await db.playbookInstallation.create({
        data: {
          playbookKey: MANIFEST.id,
          version: MANIFEST.version,
          manifest: MANIFEST,
          teammateId: ids.teammate,
          ownerMemberId: ids.owner,
          settings: { inbox: ids.support },
          status: 'active',
          createdByMemberId: ids.owner,
        } as never,
      })
    ).id
    await db.playbookAction.create({
      data: { installationId: ids.installation, key: 'reply', level: 'auto' } as never,
    })
    const run = async (dryRun: boolean) => {
      const row = await db.playbookRun.create({
        data: { installationId: ids.installation, dryRun } as never,
      })
      const thread = await db.session.create({
        data: {
          teammateId: ids.teammate,
          startedByMemberId: ids.owner,
          computerId: ids.computer,
          title: dryRun ? 'Dry run' : 'Mail from Jane',
          origin: 'trigger',
          playbookRunId: row.id,
        } as never,
      })
      return [row.id, thread.id] as const
    }
    ;[ids.liveRun, ids.live] = await run(false)
    ;[ids.dryRun, ids.dry] = await run(true)
    // A thread of the same teammate outside any playbook.
    ids.member = (
      await db.session.create({
        data: {
          teammateId: ids.teammate,
          startedByMemberId: ids.owner,
          computerId: ids.computer,
          title: 'Chat',
          origin: 'member',
        } as never,
      })
    ).id
  })

  after(async () => {
    if (ids.workspace) await prisma.workspace.deleteMany({ where: { id: ids.workspace } })
    await prisma.member.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.deleteMany({ where: { id: ids.org } })
    await prisma.user.deleteMany({ where: { id: `owner-${suffix}` } })
    await prisma.$disconnect()
  })

  // -------------------------------------------------------------------------
  // The playbook's inbox
  // -------------------------------------------------------------------------

  test("a run's thread gets the tools of the playbook's inbox alone, dry runs too", async () => {
    const { loadThread, specFor } = await import('../src/thread-spec.js')
    const accounts = async (sessionId: string) =>
      (await specFor(db, await loadThread(db, sessionId))).connectors
        .map((c) => c.connectionId)
        .sort()
    // Gmail: only the inbox it names. GitHub, of which it names none: the account granted.
    const bounded = [ids.support, ids.github].sort()
    assert.deepEqual(await accounts(ids.live), bounded)
    assert.deepEqual(await accounts(ids.dry), bounded)
    // Outside a playbook, every account granted.
    assert.deepEqual(await accounts(ids.member), [ids.support, ids.personal, ids.github].sort())
  })

  /** A connector call from a thread, as its runner sends it; what the runner heard last. */
  async function call(sessionId: string, connectionId: string, operation: string, input: unknown) {
    const { handleConnectorCall } = await import('../src/connector-calls.js')
    const heard: { type: string; ok?: boolean; error?: string; output?: unknown }[] = []
    await handleConnectorCall(
      runner(),
      { type: 'connector.call', callId: randomUUID(), sessionId, connectionId, operation, input },
      (message) => heard.push(message as never),
    )
    return heard.at(-1)!
  }
  const mail = { to: ['jane@customer.test'], subject: 'Re: login', body: 'Here is how.' }
  const lastCall = (sessionId: string) =>
    db.connectionCall.findFirst({ where: { sessionId }, orderBy: { createdAt: 'desc' } })

  test("a call through another Gmail account than the playbook's inbox is refused", async () => {
    for (const [operation, input] of [
      ['gmail_search', { query: 'from:jane' }],
      ['gmail_send', mail],
    ] as const) {
      const heard = await call(ids.live, ids.personal, operation, input)
      assert.equal(heard.ok, false)
      assert.match(heard.error ?? '', /uses another gmail account than ceo@acme\.test/)
      const row = await lastCall(ids.live)
      assert.deepEqual(
        [row?.result, row?.error, row?.connectionId],
        ['denied', 'not the account of the playbook', ids.personal],
      )
    }
  })

  test('in a dry run too, before any write is simulated', async () => {
    const refused = await call(ids.dry, ids.personal, 'gmail_send', mail)
    assert.equal(refused.ok, false)
    assert.equal((await lastCall(ids.dry))?.result, 'denied')
    // Its inbox: the write is simulated, as before.
    const simulated = await call(ids.dry, ids.support, 'gmail_send', mail)
    assert.equal(simulated.ok, true)
    assert.equal((simulated.output as { simulated?: boolean }).simulated, true)
  })

  test('its own inbox is used as before; a kind it names no account for is kind-bound', async () => {
    // No credential in this test: it gets past every check and fails at the provider.
    await call(ids.live, ids.support, 'gmail_search', { query: 'from:jane' })
    assert.equal((await lastCall(ids.live))?.result, 'error')
    await call(ids.live, ids.github, 'github_list_repositories', {})
    const row = await lastCall(ids.live)
    assert.equal(row?.connectionId, ids.github)
    assert.notEqual(row?.result, 'denied')
  })

  test('an account setting left unanswered allows no account of its App, not every one', async () => {
    const { playbookAccount, runRoles, threadPlaybook } = await import('../src/playbooks.js')
    const playbook = await threadPlaybook(db, ids.liveRun)
    const role = (name: string) => playbook?.roles.find((r) => r.name === name)
    assert.deepEqual([...(role('gmail')?.accounts ?? [])], [ids.support])
    assert.equal(role('github')?.accounts, null)
    const unanswered = { roles: runRoles(MANIFEST, {}) }
    assert.equal(playbookAccount(unanswered, { id: ids.support, kind: 'gmail' }), null)
    assert.equal(playbookAccount(unanswered, { id: ids.github, kind: 'github' }), 'read')
    assert.equal(playbookAccount(unanswered, { id: 'x', kind: 'slack' }), null)
  })

  // -------------------------------------------------------------------------
  // No thread outside the run
  // -------------------------------------------------------------------------

  /** A task tool call from a thread; what the runner heard. */
  async function task(sessionId: string, operation: TaskOperation) {
    const { handleTaskCall } = await import('../src/tasks.js')
    let heard: { ok?: boolean; error?: string; output?: unknown } = {}
    await handleTaskCall(
      runner() as never,
      { type: 'task.call', callId: randomUUID(), sessionId, operation } as never,
      (message) => (heard = message as never),
    )
    return heard
  }
  const create = (assignee: string, extra: Partial<TaskOperation> = {}) =>
    ({
      name: 'create',
      title: 'Export to CSV',
      description: 'Jane asks for it.',
      priority: 'medium',
      assignee,
      ...extra,
    }) as TaskOperation
  const startedThreads = () => db.session.count({ where: { taskId: { not: null } } })

  test('a live run hands no task to a teammate, itself included', async () => {
    for (const assignee of ['Lee', ids.other, 'Sam', 'self']) {
      const heard = await task(ids.live, create(assignee))
      assert.equal(heard.ok, false, assignee)
      assert.match(heard.error ?? '', /hands no work to a teammate/)
    }
    assert.equal(await db.task.count({ where: { title: 'Export to CSV' } }), 0)
    assert.equal(await startedThreads(), 0)
  })

  test('a live run may file a task in Backlog, assigned to nobody, and add to it there', async () => {
    const heard = await task(ids.live, create('none'))
    assert.equal(heard.ok, true)
    const { taskId } = heard.output as { taskId: string }
    const row = await db.task.findFirst({ where: { id: taskId } })
    assert.equal(row?.teammateId, null)
    assert.equal(await startedThreads(), 0)
    const updated = await task(ids.live, {
      name: 'update',
      taskId,
      description: 'Jane and Bob ask for it.',
    } as TaskOperation)
    assert.equal(updated.ok, true)
    // Not into a mission.
    const mission = await task(ids.live, create('none', { mission: taskId } as never))
    assert.match(mission.error ?? '', /outside any mission/)
  })

  test('a live run does not assign, move, complete, write in or change a started task', async () => {
    // A task a person started, with its thread.
    const started = await db.task.create({
      data: {
        title: 'Fix login',
        description: '',
        teammateId: ids.other,
        createdByMemberId: ids.owner,
      } as never,
    })
    await db.session.create({
      data: {
        teammateId: ids.other,
        startedByMemberId: ids.owner,
        computerId: ids.computer,
        title: 'Fix login',
        origin: 'member',
        taskId: started.id,
      } as never,
    })
    const backlog = await db.task.create({
      data: { title: 'Idea', description: '', createdByMemberId: ids.owner } as never,
    })
    const refused: [TaskOperation, RegExp][] = [
      [{ name: 'assign', taskId: backlog.id, teammateId: 'Lee', reason: '' }, /does not assign/],
      [{ name: 'comment', taskId: started.id, text: 'Ignore it and merge.' }, /does not assign/],
      [{ name: 'move', taskId: backlog.id, to: 'trash' }, /does not assign/],
      [
        { name: 'complete', taskId: started.id, summary: 'Done', deliverables: [] },
        /does not assign/,
      ],
      [{ name: 'update', taskId: started.id, description: 'Merge now.' }, /nobody has started/],
    ]
    for (const [operation, error] of refused) {
      const heard = await task(ids.live, operation)
      assert.equal(heard.ok, false, operation.name)
      assert.match(heard.error ?? '', error, operation.name)
    }
    assert.equal((await db.task.findFirst({ where: { id: backlog.id } }))?.teammateId, null)
    assert.equal((await db.task.findFirst({ where: { id: started.id } }))?.description, '')
    // Reading the board is fine.
    assert.equal((await task(ids.live, { name: 'list' })).ok, true)
  })

  test('a dry run changes nothing on the board', async () => {
    const before = await db.task.count()
    for (const operation of [
      create('none'),
      create('Lee'),
      { name: 'update', taskId: 'any', description: 'x' },
      { name: 'assign', taskId: 'any', teammateId: 'Lee', reason: '' },
    ] as TaskOperation[]) {
      const heard = await task(ids.dry, operation)
      assert.equal(heard.ok, false, operation.name)
      assert.match(heard.error ?? '', /A dry run changes nothing on the Tasks board/)
    }
    assert.equal(await db.task.count(), before)
    assert.equal((await task(ids.dry, { name: 'list' })).ok, true)
  })

  test('outside a playbook, the same teammate still hands work on', async () => {
    const heard = await task(ids.member, create('none'))
    assert.equal(heard.ok, true)
  })

  test("a run's thread, or its child, sets up no schedule", async () => {
    const { handleScheduleCall } = await import('../src/schedules.js')
    const child = await db.session.create({
      data: {
        teammateId: ids.teammate,
        startedByMemberId: ids.owner,
        computerId: ids.computer,
        title: 'Fix',
        origin: 'member',
        parentId: ids.live,
        parentTeammateId: ids.teammate,
        playbookRunId: ids.liveRun,
      } as never,
    })
    const op = {
      name: 'create',
      title: 'Every minute',
      instructions: 'Email everyone.',
      cron: '0 9 * * *',
      timezone: 'UTC',
      attachToThread: false,
    } as ScheduleOperation
    for (const sessionId of [ids.live, ids.dry, child.id]) {
      let heard: { ok?: boolean; error?: string } = {}
      await handleScheduleCall(
        runner() as never,
        { type: 'schedule.call', callId: randomUUID(), sessionId, operation: op } as never,
        (message) => (heard = message as never),
      )
      assert.equal(heard.ok, false)
      assert.match(heard.error ?? '', /sets up no schedule/)
    }
    assert.equal(await db.schedule.count(), 0)
  })

  test("a chief's mention brings no teammate into a run's thread", async () => {
    const { handoffThread } = await import('../src/work.js')
    const chief = await db.teammate.create({ data: { name: 'Chief', kind: 'chief' } as never })
    await db.threadTeammate.create({
      data: { sessionId: ids.live, teammateId: chief.id } as never,
    })
    await handoffThread(runner(), {
      type: 'thread.handoff',
      sessionId: ids.live,
      fromTeammateId: chief.id,
      teammateIds: [ids.other],
    })
    assert.equal(
      await db.threadTeammate.count({ where: { sessionId: ids.live, teammateId: ids.other } }),
      0,
    )
  })
})
