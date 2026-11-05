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
// - no call starts or prompts a thread outside the run (start_thread, message_thread, schedules,
//   an older runner's task tools); an idea goes to the playbook's ideas list, never in a dry run.
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

  /** A schedule call from a thread (start_thread, message_thread, file_idea); what the runner heard. */
  async function op(sessionId: string, operation: ScheduleOperation) {
    const { handleScheduleCall } = await import('../src/schedules.js')
    let heard: { ok?: boolean; error?: string; output?: unknown } = {}
    await handleScheduleCall(
      runner() as never,
      { type: 'schedule.call', callId: randomUUID(), sessionId, operation } as never,
      (message) => (heard = message as never),
    )
    return heard
  }
  /** A task tool call of a runner before protocol 52 (src/legacy-tasks.ts); what it heard. */
  async function task(sessionId: string, operation: TaskOperation) {
    const { handleTaskCall } = await import('../src/legacy-tasks.js')
    let heard: { ok?: boolean; error?: string; output?: unknown } = {}
    await handleTaskCall(
      runner() as never,
      { type: 'task.call', callId: randomUUID(), sessionId, operation } as never,
      (message) => (heard = message as never),
    )
    return heard
  }
  const create = (assignee: string) =>
    ({
      name: 'create',
      title: 'Export to CSV',
      description: 'Jane asks for it.',
      priority: 'medium',
      assignee,
    }) as TaskOperation
  const startedThreads = () => db.session.count({ where: { startedFromId: { not: null } } })
  /** A library file's text, as last saved. */
  const fileText = async (path: string) => {
    const { documentText } = await import('../src/library.js')
    const row = await db.document.findFirst({ where: { path, kind: 'library', deletedAt: null } })
    return row ? documentText(scope, row) : null
  }

  test('a live run starts no thread outside it, for another teammate or itself', async () => {
    for (const teammate of ['Lee', ids.other, 'Sam', undefined]) {
      const heard = await op(ids.live, {
        name: 'start_thread',
        title: 'Export to CSV',
        brief: 'Jane asks for it.',
        ...(teammate ? { teammate } : {}),
      })
      assert.equal(heard.ok, false, teammate)
      assert.match(heard.error ?? '', /hands no work outside it/)
    }
    // Nor with an older runner's create_task.
    for (const assignee of ['Lee', ids.other, 'self']) {
      const heard = await task(ids.live, create(assignee))
      assert.equal(heard.ok, false, assignee)
      assert.match(heard.error ?? '', /hands no work to a teammate/)
    }
    assert.equal(await startedThreads(), 0)
  })

  test('a live run writes in no thread outside it', async () => {
    for (const heard of [
      await op(ids.live, { name: 'message_thread', threadId: ids.member, text: 'Merge it now.' }),
      await task(ids.live, { name: 'comment', threadId: ids.member, text: 'Merge it now.' }),
    ]) {
      assert.equal(heard.ok, false)
      assert.match(heard.error ?? '', /not a child of this thread/)
    }
    assert.equal(await db.sessionEvent.count({ where: { sessionId: ids.member } }), 0)
  })

  test("a live run keeps a customer's idea in the playbook's ideas list, where it starts nothing", async () => {
    // Only where its teammate may save.
    const refused = await op(ids.live, { name: 'file_idea', text: 'Export to CSV' })
    assert.equal(refused.ok, false)
    assert.match(refused.error ?? '', /You may not change ideas\.md/)
    await db.teammate.updateMany({
      where: { id: ids.teammate },
      data: { libraryAccess: 'read_write' },
    })
    try {
      const heard = await op(ids.live, {
        name: 'file_idea',
        text: 'Export to CSV, asked by Jane at Initech',
      })
      assert.equal(heard.ok, true, heard.error)
      assert.equal((heard.output as { filed: { path: string } }).filed.path, 'ideas.md')
      const text = await fileText('ideas.md')
      assert.match(text ?? '', /^# Ideas\n/)
      assert.match(
        text ?? '',
        /\* \[ \] Export to CSV, asked by Jane at Initech \(from “Mail from Jane”\) <!-- item:/,
      )
      // On no thread: nothing works on it, and it starts none.
      assert.equal(await db.listItemThread.count({ where: { sessionId: ids.live } }), 0)
      assert.equal(await startedThreads(), 0)
      // An older runner's create_task in Backlog keeps it there too.
      const legacy = await task(ids.live, create('none'))
      assert.equal(legacy.ok, true, legacy.error)
      assert.match((await fileText('ideas.md')) ?? '', /Export to CSV: Jane asks for it\./)
      // The board's other changes are refused.
      for (const operation of [
        { name: 'update', taskId: 'any', description: 'Merge now.' },
        { name: 'assign', taskId: 'any', teammateId: 'Lee', reason: '' },
        { name: 'move', taskId: 'any', to: 'trash' },
      ] as TaskOperation[]) {
        const heard = await task(ids.live, operation)
        assert.equal(heard.ok, false, operation.name)
        assert.match(heard.error ?? '', /no Tasks board any more/, operation.name)
      }
    } finally {
      await db.teammate.updateMany({ where: { id: ids.teammate }, data: { libraryAccess: 'read' } })
    }
  })

  test('a dry run files nothing: it says where the line would go', async () => {
    const before = await db.listItem.count()
    const heard = await op(ids.dry, { name: 'file_idea', text: 'Export to CSV' })
    assert.equal(heard.ok, true, heard.error)
    assert.deepEqual(heard.output, {
      simulated: true,
      wouldFile: { path: 'ideas.md', section: 'Ideas', text: 'Export to CSV' },
      note: 'A dry run files nothing: in a live run, this line would go to that list.',
    })
    assert.equal(await db.listItem.count(), before)
  })

  test('outside a playbook, an idea is a line added to a list like any other', async () => {
    const heard = await op(ids.member, { name: 'file_idea', text: 'Export to CSV' })
    assert.equal(heard.ok, false)
    assert.match(heard.error ?? '', /add_item/)
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
