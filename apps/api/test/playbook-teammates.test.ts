import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'
import { PlaybookManifest } from '@brigade/contracts'

// A playbook split between teammates (support reads the mail, developer fixes the code), against
// the API's development database (apps/api/.env), in an organization of its own removed at the
// end; skipped when none answers:
// - its manifest names the teammate its runs start with, and each App's teammate is a setting;
// - installing from the chat asks who answers the customers (never the chief by default), then
//   who fixes the bugs, the same teammate or another, and asks each App for its own teammate;
// - a run's thread has its teammate's Apps alone, and a child handed to `developer` the others,
//   whether the same teammate holds both or not; git refuses a thread without GitHub;
// - an installation still in setup moves to the template's new version, its answers kept.
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

const TEAM = {
  id: 'brigade/test-team',
  name: 'Support',
  version: '1.0.0',
  description: 'Answers the inbox and fixes the bugs.',
  teammate: 'support',
  apps: [
    { kind: 'gmail', access: 'read_write' },
    { kind: 'github', access: 'read_write', teammate: 'developer' },
  ],
  settings: [
    { key: 'support', type: 'teammate', ask: 'Which teammate answers the customers?' },
    { key: 'inbox', type: 'account', app: 'gmail' },
    { key: 'developer', type: 'teammate', ask: 'Which teammate fixes the bugs in the code?' },
  ],
  entries: [{ schedule: '0 8 * * 1', instructions: 'Review the week.' }],
  skills: [],
  actions: [],
  limits: { runsPerDay: 100 },
  promotion: { decisions: 30, approvedRate: 0.95 },
  metrics: [],
} satisfies PlaybookManifest

describe('the teammates of a playbook', { skip: !database && 'no database answers' }, () => {
  const suffix = randomUUID().slice(0, 8)
  const ids = {} as Record<
    | 'org'
    | 'workspace'
    | 'owner'
    | 'computer'
    | 'chief'
    | 'sam'
    | 'dev'
    | 'gmail'
    | 'github'
    | 'split'
    | 'same'
    | 'chat',
    string
  >
  let db: ReturnType<typeof scoped>
  let scope: { organizationId: string; workspaceId: string }

  before(async () => {
    ids.org = `org-team-${suffix}`
    await prisma.organization.create({
      data: { id: ids.org, name: 'Team', slug: `team-${suffix}` },
    })
    await prisma.user.create({
      data: { id: `owner-${suffix}`, name: 'Ada', email: `owner-${suffix}@test.local` },
    })
    ids.owner = `m-owner-${suffix}`
    await prisma.member.create({
      data: { id: ids.owner, organizationId: ids.org, userId: `owner-${suffix}`, role: 'owner' },
    })
    ids.workspace = (
      await prisma.workspace.create({ data: { organizationId: ids.org, name: 'Team' } })
    ).id
    scope = { organizationId: ids.org, workspaceId: ids.workspace }
    db = scoped(scope)
    ids.computer = (
      await db.computer.create({
        data: { kind: 'member_machine', memberId: ids.owner, name: 'Laptop' } as never,
      })
    ).id
    await prisma.runner.create({
      data: { ...scope, computerId: ids.computer, tokenHash: `hash-${suffix}` } as never,
    })
    await db.account.create({
      data: {
        memberId: ids.owner,
        computerId: ids.computer,
        provider: 'claude_code',
        label: 'Claude',
        status: 'ready',
      } as never,
    })
    ids.chief = (await db.teammate.create({ data: { name: 'Chief', kind: 'chief' } as never })).id
    ids.sam = (await db.teammate.create({ data: { name: 'Sam' } as never })).id
    ids.dev = (await db.teammate.create({ data: { name: 'Dev' } as never })).id

    const app = (key: string) =>
      db.app.create({ data: { key, createdByMemberId: ids.owner } as never })
    const connection = async (appId: string, kind: string, label: string) =>
      (
        await db.connection.create({
          data: {
            appId,
            kind,
            label,
            externalAccount: label,
            createdByMemberId: ids.owner,
          } as never,
        })
      ).id
    ids.gmail = await connection((await app('gmail')).id, 'gmail', 'support@acme.test')
    ids.github = await connection((await app('github')).id, 'github', 'acme')
    // Both hold both Apps: what a thread reaches comes from the playbook, not from its grants.
    for (const teammateId of [ids.sam, ids.dev])
      for (const connectionId of [ids.gmail, ids.github])
        await db.grant.create({ data: { teammateId, connectionId, scope: 'read_write' } as never })

    const install = async (settings: Record<string, string>) =>
      (
        await db.playbookInstallation.create({
          data: {
            playbookKey: TEAM.id,
            version: TEAM.version,
            manifest: TEAM,
            teammateId: ids.sam,
            ownerMemberId: ids.owner,
            settings,
            status: 'active',
            createdByMemberId: ids.owner,
          } as never,
        })
      ).id
    ids.split = await install({ support: ids.sam, inbox: ids.gmail, developer: ids.dev })
    ids.same = await install({ support: ids.sam, inbox: ids.gmail, developer: ids.sam })
    // A member's thread with the chief, where playbooks are installed from.
    ids.chat = (
      await db.session.create({
        data: {
          teammateId: ids.chief,
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

  /** A new run's root thread, with the teammate its runs start with. */
  async function runThread(installationId: string) {
    const run = await db.playbookRun.create({ data: { installationId } as never })
    const thread = await db.session.create({
      data: {
        teammateId: ids.sam,
        startedByMemberId: ids.owner,
        computerId: ids.computer,
        title: 'Mail from Jane',
        origin: 'trigger',
        playbookRunId: run.id,
      } as never,
    })
    await db.threadTeammate.create({ data: { sessionId: thread.id, teammateId: ids.sam } as never })
    return thread
  }

  /** The accounts a thread's spec hands its runner, and its playbook as the runner reads it. */
  async function spec(sessionId: string) {
    const { loadThread, specFor } = await import('../src/thread-spec.js')
    const made = await specFor(db, await loadThread(db, sessionId))
    return {
      connectors: made.connectors.map((c) => c.connectionId).sort(),
      playbook: made.playbook,
      git: !!made.git,
    }
  }

  /** start_child from a thread, as its runner sends it; the child made, if any. */
  async function startChild(thread: { id: string }, teammate?: string) {
    const { handleChildCall } = await import('../src/children.js')
    const session = await db.session.findFirst({ where: { id: thread.id } })
    const said = (await handleChildCall(db, scope, session!, { id: ids.sam, name: 'Sam' }, {
      name: 'start_child',
      title: 'Fix the export',
      instructions: 'The export fails with a 500 on large files.',
      wait: false,
      ...(teammate ? { teammate } : {}),
    } as never)) as { error?: string }
    const child = await db.session.findFirst({
      where: { parentId: thread.id },
      orderBy: { createdAt: 'desc' },
    })
    return { said, child }
  }

  test('its manifest names the teammates its Apps belong to', () => {
    const parsed = (manifest: object) => PlaybookManifest.safeParse(manifest)
    assert.equal(parsed(TEAM).success, true, parsed(TEAM).error?.message)
    const { teammate: _, ...noFirst } = TEAM
    assert.match(parsed(noFirst).error!.message, /teammate names the one its runs start with/)
    const unknown = {
      ...TEAM,
      apps: [TEAM.apps[0], { ...TEAM.apps[1], teammate: 'reviewer' }],
    }
    assert.match(parsed(unknown).error!.message, /reviewer is not one of its teammate settings/)
    const optional = {
      ...TEAM,
      settings: TEAM.settings.map((s) => (s.key === 'developer' ? { ...s, optional: true } : s)),
    }
    assert.match(parsed(optional).error!.message, /a teammate setting is always asked/)
    // A trigger starts its runs, so its App is the first teammate's.
    const trigger = {
      ...TEAM,
      apps: [{ kind: 'gmail', access: 'read_write', teammate: 'developer' }, TEAM.apps[1]],
      entries: [{ trigger: 'gmail.email_received', account: '{{inbox}}', options: {} }],
    }
    assert.match(parsed(trigger).error!.message, /gmail starts its runs/)
  })

  test("a run's thread has the support teammate's Apps, a child handed to developer the others", async () => {
    const root = await runThread(ids.split)
    const here = await spec(root.id)
    assert.deepEqual(here.connectors, [ids.gmail])
    assert.equal(here.git, false)
    assert.deepEqual(here.playbook?.apps, ['gmail'])
    assert.deepEqual(here.playbook?.teammates, [
      { key: 'support', name: 'Sam', apps: ['gmail'], here: true },
      { key: 'developer', name: 'Dev', apps: ['github'], here: false },
    ])

    const { said, child } = await startChild(root, 'developer')
    assert.notEqual(child, null, said.error)
    assert.equal(child!.teammateId, ids.dev)
    assert.equal(child!.playbookTeammate, 'developer')
    assert.equal(child!.playbookRunId, root.playbookRunId)
    const there = await spec(child!.id)
    assert.deepEqual(there.connectors, [ids.github])
    assert.equal(there.git, true)
    assert.equal(there.playbook?.teammates?.find((t) => t.here)?.key, 'developer')
  })

  test('the same teammate holding both still keeps each thread to its own Apps', async () => {
    const root = await runThread(ids.same)
    assert.deepEqual((await spec(root.id)).connectors, [ids.gmail])
    // By its key, or by the teammate's name: Sam holds support (this thread's) and developer.
    const { child } = await startChild(root, 'developer')
    assert.equal(child!.teammateId, ids.sam)
    assert.equal(child!.playbookTeammate, 'developer')
    assert.deepEqual((await spec(child!.id)).connectors, [ids.github])
    await db.session.deleteMany({ where: { id: child!.id } })
    const { child: own } = await startChild(root, 'Sam')
    assert.equal(own!.playbookTeammate, null)
    assert.deepEqual((await spec(own!.id)).connectors, [ids.gmail])
  })

  test("a child goes only to one of the playbook's teammates", async () => {
    const root = await runThread(ids.split)
    const stranger = await db.teammate.create({ data: { name: 'Stranger' } as never })
    const { said, child } = await startChild(root, 'Stranger')
    await db.teammate.deleteMany({ where: { id: stranger.id } })
    assert.equal(child, null)
    assert.match(said.error!, /by its key: support \(Sam\), developer \(Dev\)/)
  })

  test('git refuses a playbook thread whose teammate has no GitHub', async () => {
    const { authorize, gitAccess, GitRefused } = await import('../src/git.js')
    const root = await runThread(ids.split)
    const { token } = gitAccess(
      { sessionId: root.id, teammateId: ids.sam, computerId: ids.computer },
      { name: 'Sam' },
    )
    await assert.rejects(
      authorize(`Bearer ${token}`, 'acme', 'app'),
      (error: Error) =>
        error instanceof GitRefused && /has no GitHub; hand code work/.test(error.message),
    )
    const { child } = await startChild(root, 'developer')
    const { token: childToken } = gitAccess(
      { sessionId: child!.id, teammateId: ids.dev, computerId: ids.computer },
      { name: 'Dev' },
    )
    // Past the playbook's check: what refuses it now is the repository, not the thread.
    await assert.rejects(
      authorize(`Bearer ${childToken}`, 'acme', 'app'),
      (error: Error) => !/has no GitHub; hand code work/.test(error.message),
    )
  })

  test('installing from the chat asks who answers the customers, then who fixes the bugs', async () => {
    const { handlePlaybookCall } = await import('../src/playbook-chat.js')
    const session = await db.session.findFirst({ where: { id: ids.chat } })
    type Said = {
      installationId: string
      teammate: string
      missing: { key: string; teammates?: string[] }[]
      apps: { name: string; status: string; holder: { name: string } | null }[]
      next: string
      error?: string
    }
    const configure = async (op: object) =>
      (await handlePlaybookCall(db, scope, session!, { id: ids.chief, name: 'Chief' }, {
        name: 'configure_playbook',
        settings: {},
        ...op,
      } as never)) as Said
    const first = await configure({ playbookKey: 'brigade/support-bugs' })
    assert.equal(first.error, undefined)
    assert.equal(first.missing[0]!.key, 'support')
    // The chief routes work: it is not offered, and it is no App's teammate yet.
    assert.deepEqual(first.missing[0]!.teammates, ['Sam', 'Dev'])
    assert.match(first.next, /Do not pick yourself/)
    assert.match(first.next, /choices block, one option per teammate/)
    assert.ok(first.apps.every((a) => a.holder === null))
    assert.doesNotMatch(first.next, /open one ticket/)

    const second = await configure({
      installationId: first.installationId,
      teammate: 'Sam',
      settings: { product: 'Acme', repo: 'acme/app' },
    })
    assert.equal(second.teammate, 'Sam')
    assert.ok(second.missing.some((q) => q.key === 'developer'))

    // Its developer: the same teammate, or another; each App for its own.
    const split = await configure({
      installationId: first.installationId,
      settings: { developer: 'dev' },
    })
    const github = split.apps.find((a) => a.name === 'github')!
    assert.equal(github.holder?.name, 'Dev')
    assert.equal(split.apps.find((a) => a.name === 'gmail')!.holder?.name, 'Sam')

    await db.grant.deleteMany({ where: { teammateId: ids.dev, connectionId: ids.github } })
    const lacking = await configure({ installationId: first.installationId })
    assert.match(lacking.next, /github \(no account, for Dev\)/)
    assert.match(lacking.next, /app\.teammate set to the teammate it is for/)
    await db.grant.create({
      data: { teammateId: ids.dev, connectionId: ids.github, scope: 'read_write' } as never,
    })
  })

  test('the developer question offers the same teammate or another, and says what each means', async () => {
    const { handlePlaybookCall } = await import('../src/playbook-chat.js')
    const session = await db.session.findFirst({ where: { id: ids.chat } })
    const installation = await db.playbookInstallation.findFirst({
      where: { playbookKey: 'brigade/support-bugs', status: 'setup' },
    })
    await db.playbookInstallation.updateMany({
      where: { id: installation!.id },
      data: {
        settings: {
          support: ids.sam,
          product: 'Acme',
          inbox: ids.gmail,
          address: 'support@acme.test',
          docs: 'https://docs.acme.test',
          repo: 'acme/app',
        },
      },
    })
    const said = (await handlePlaybookCall(db, scope, session!, { id: ids.chief, name: 'Chief' }, {
      name: 'configure_playbook',
      installationId: installation!.id,
      settings: {},
    } as never)) as { missing: { key: string }[]; next: string }
    assert.deepEqual(
      said.missing.map((q) => q.key),
      ['developer'],
    )
    assert.match(
      said.next,
      /Offer the same teammate as for "Which teammate answers the customers\?"/,
    )
    assert.match(said.next, /never holds github/)
  })

  test('an optional App is asked for the teammate that holds it, not the one installing', async () => {
    const { handlePlaybookCall } = await import('../src/playbook-chat.js')
    const session = await db.session.findFirst({ where: { id: ids.chat } })
    const manifest = {
      ...TEAM,
      id: 'brigade/test-team-stripe',
      apps: [...TEAM.apps, { kind: 'stripe', access: 'read', optional: true }],
    } satisfies PlaybookManifest
    const installation = await db.playbookInstallation.create({
      data: {
        playbookKey: manifest.id,
        version: manifest.version,
        manifest,
        teammateId: ids.sam,
        ownerMemberId: ids.owner,
        settings: { support: ids.sam, inbox: ids.gmail, developer: ids.dev },
        status: 'setup',
        createdByMemberId: ids.owner,
      } as never,
    })
    const said = (await handlePlaybookCall(db, scope, session!, { id: ids.chief, name: 'Chief' }, {
      name: 'configure_playbook',
      installationId: installation.id,
      settings: {},
    } as never)) as { missing: unknown[]; next: string; error?: string }
    assert.equal(said.error, undefined)
    assert.deepEqual(said.missing, [])
    assert.match(said.next, /It can also use optional Apps: stripe \(no account, for Sam\)\./)
    assert.match(said.next, /app\.teammate set to the teammate it is for/)
  })

  test('an access ask for another teammate names it by id from the moment it is stored', async () => {
    const { withTeammateIds } = await import('../src/hub.js')
    // A teammate named after another's id: by id first, as granting reads it.
    const tricky = await db.teammate.create({ data: { name: ids.dev } as never })
    const twin = await db.teammate.create({ data: { name: 'Sam' } as never })
    try {
      const ticket = (teammate: string) => ({
        sessionId: 's',
        seq: 1,
        event: {
          type: 'ticket.opened',
          at: new Date().toISOString(),
          requestId: 'r',
          title: 'Access',
          asks: [
            {
              id: 'a',
              type: 'access',
              kind: 'connection',
              what: 'GitHub',
              app: { kind: 'github', scope: 'read_write', teammate },
            },
            { id: 'b', type: 'input', question: 'Which repository?' },
          ],
        },
      })
      const teammateOf = async (ref: string) => {
        const [stored] = await withTeammateIds(scope, [ticket(ref)] as never)
        const ask = (stored!.event as { asks: { app?: { teammate?: string } }[] }).asks[0]!
        return ask.app?.teammate
      }
      assert.equal(await teammateOf(ids.dev), ids.dev)
      assert.equal(await teammateOf('dev'), ids.dev)
      // Two called Sam: neither, as written, and granting refuses it.
      assert.equal(await teammateOf('Sam'), 'Sam')
      assert.equal(await teammateOf('Nobody'), 'Nobody')
    } finally {
      await db.teammate.deleteMany({ where: { id: { in: [tricky.id, twin.id] } } })
    }
  })

  test('a teammate archived since it was picked is asked again, and holds no App', async () => {
    const { handlePlaybookCall } = await import('../src/playbook-chat.js')
    const session = await db.session.findFirst({ where: { id: ids.chat } })
    const gone = await db.teammate.create({ data: { name: 'Gone' } as never })
    const installation = await db.playbookInstallation.create({
      data: {
        playbookKey: TEAM.id,
        version: TEAM.version,
        manifest: TEAM,
        teammateId: ids.sam,
        ownerMemberId: ids.owner,
        settings: { support: ids.sam, inbox: ids.gmail, developer: gone.id },
        status: 'setup',
        createdByMemberId: ids.owner,
      } as never,
    })
    await db.teammate.updateMany({ where: { id: gone.id }, data: { archivedAt: new Date() } })
    const said = (await handlePlaybookCall(db, scope, session!, { id: ids.chief, name: 'Chief' }, {
      name: 'configure_playbook',
      installationId: installation.id,
      settings: {},
    } as never)) as {
      missing: { key: string }[]
      apps: { name: string; holder: unknown; status: string }[]
    }
    assert.deepEqual(
      said.missing.map((q) => q.key),
      ['developer'],
    )
    const github = said.apps.find((a) => a.name === 'github')!
    assert.equal(github.holder, null)
    assert.equal(github.status, 'missing')
  })

  test('an installation in a dry run under way waits for it before moving to the new version', async () => {
    const { upgradeSetup, templates } = await import('../src/playbooks.js')
    const template = templates().get('brigade/support-bugs')!
    const installation = await db.playbookInstallation.create({
      data: {
        playbookKey: template.manifest.id,
        version: '1.0.0',
        manifest: template.manifest,
        teammateId: ids.sam,
        ownerMemberId: ids.owner,
        settings: {},
        status: 'dry_run',
        createdByMemberId: ids.owner,
      } as never,
    })
    const dryRun = await db.playbookDryRun.create({
      data: {
        installationId: installation.id,
        teammateId: ids.sam,
        startedByMemberId: ids.owner,
        status: 'running',
      } as never,
    })
    const installer = { ...scope, memberId: ids.owner }
    assert.equal((await upgradeSetup(db, installer, installation, template)).version, '1.0.0')
    await db.playbookDryRun.updateMany({ where: { id: dryRun.id }, data: { status: 'done' } })
    assert.equal(
      (await upgradeSetup(db, installer, installation, template)).version,
      template.manifest.version,
    )
    await db.playbookInstallation.deleteMany({ where: { id: installation.id } })
  })

  test('an installation still in setup moves to the new version, its answers kept', async () => {
    const { handlePlaybookCall } = await import('../src/playbook-chat.js')
    const { templates } = await import('../src/playbooks.js')
    const session = await db.session.findFirst({ where: { id: ids.chat } })
    await db.playbookInstallation.deleteMany({ where: { playbookKey: 'brigade/support-bugs' } })
    const current = templates().get('brigade/support-bugs')!.manifest
    // As 1.0.0 had it: one teammate, every App.
    const old = {
      ...current,
      version: '1.0.0',
      teammate: undefined,
      apps: current.apps.map(({ teammate: _, ...a }) => a),
      settings: current.settings.filter((s) => s.type !== 'teammate'),
    }
    const installation = await db.playbookInstallation.create({
      data: {
        playbookKey: old.id,
        version: old.version,
        manifest: old,
        teammateId: ids.chief,
        ownerMemberId: ids.owner,
        settings: { product: 'Acme', docs: 'https://docs.acme.test' },
        status: 'setup',
        createdByMemberId: ids.owner,
      } as never,
    })
    const said = (await handlePlaybookCall(db, scope, session!, { id: ids.chief, name: 'Chief' }, {
      name: 'configure_playbook',
      playbookKey: 'brigade/support-bugs',
      settings: {},
    } as never)) as { installationId: string; missing: { key: string }[] }
    assert.equal(said.installationId, installation.id)
    assert.equal(said.missing[0]!.key, 'support')
    const upgraded = await db.playbookInstallation.findFirst({ where: { id: installation.id } })
    assert.equal(upgraded!.version, current.version)
    assert.deepEqual(upgraded!.settings, { product: 'Acme', docs: 'https://docs.acme.test' })

    // Gone on with by its id, as the thread that started it does: the same.
    await db.playbookInstallation.updateMany({
      where: { id: installation.id },
      data: { version: '1.0.0', manifest: old as never },
    })
    const byId = (await handlePlaybookCall(db, scope, session!, { id: ids.chief, name: 'Chief' }, {
      name: 'configure_playbook',
      installationId: installation.id,
      settings: { support: 'Sam' },
    } as never)) as { teammate: string; missing: { key: string }[] }
    assert.equal(byId.teammate, 'Sam')
    assert.equal(byId.missing[0]!.key, 'inbox')
  })
})
