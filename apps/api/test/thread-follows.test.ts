import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import pg from 'pg'

// follow_thread (src/children.ts) against a real database: the local one of apps/api/.env, in an
// organization of its own that it removes at the end. Without a database to reach, it is skipped.
const fromEnvFile = () => {
  try {
    const line = readFileSync(new URL('../.env', import.meta.url), 'utf8')
      .split('\n')
      .find((l) => l.startsWith('DATABASE_URL='))
    return line?.slice('DATABASE_URL='.length).replace(/^"|"$/g, '') || undefined
  } catch {
    return undefined
  }
}
process.env.DATABASE_URL ??= fromEnvFile() ?? 'postgresql://test@localhost/test'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')

async function reachable() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  })
  try {
    await client.connect()
    await client.query('select 1 from "ThreadFollow" limit 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}
const skip = (await reachable()) ? false : 'no database to reach (apps/api/.env DATABASE_URL)'

const { childNote, FOLLOWERS_PER_THREAD } = await import('@brigade/contracts')
const { prisma, scoped } = await import('../src/db.js')
const { handleChildCall, noteChildEvents, settleOverdueChildren } =
  await import('../src/children.js')

type Row = Awaited<ReturnType<typeof prisma.session.create>>
const id = randomUUID().slice(0, 8)
const ids = {
  organization: `org-follow-${id}`,
  user: `user-follow-${id}`,
  member: `mem-follow-${id}`,
}
let scope: { organizationId: string; workspaceId: string }
let teammate: { id: string; name: string }
let computerId: string
let support: string
let otherPlaybook: string

before(async () => {
  if (skip) return
  await prisma.organization.create({
    data: { id: ids.organization, name: 'Follow test', slug: ids.organization },
  })
  await prisma.user.create({
    data: { id: ids.user, name: 'Ada', email: `${ids.user}@example.com` },
  })
  await prisma.member.create({
    data: { id: ids.member, organizationId: ids.organization, userId: ids.user, role: 'owner' },
  })
  const workspace = await prisma.workspace.create({
    data: { organizationId: ids.organization, name: 'Follow test' },
  })
  scope = { organizationId: ids.organization, workspaceId: workspace.id }
  const riley = await prisma.teammate.create({ data: { ...scope, name: 'Riley' } })
  teammate = { id: riley.id, name: riley.name }
  // A member's machine with a Claude account, offline: a wake-up's prompt finds it so and
  // waits, as it would.
  const computer = await prisma.computer.create({
    data: { ...scope, kind: 'member_machine', memberId: ids.member, name: 'Laptop' },
  })
  computerId = computer.id
  await prisma.account.create({
    data: {
      ...scope,
      memberId: ids.member,
      computerId,
      provider: 'claude_code',
      label: 'Claude',
      status: 'ready',
    },
  })
  const installation = (key: string) =>
    prisma.playbookInstallation.create({
      data: {
        ...scope,
        playbookKey: key,
        version: '1.0.0',
        manifest: { name: 'Support', apps: [], actions: [] },
        teammateId: riley.id,
        ownerMemberId: ids.member,
        createdByMemberId: ids.member,
        status: 'active',
      },
    })
  support = (await installation('brigade/support-bugs')).id
  otherPlaybook = (await installation('brigade/ship-and-tell')).id
})

after(async () => {
  if (skip) return
  // The workspace's rows go with it, the append-only logs included.
  await prisma.organization.deleteMany({ where: { id: ids.organization } })
  await prisma.user.deleteMany({ where: { id: ids.user } })
  await prisma.$disconnect()
})

let titles = 0
const thread = (data: {
  title?: string
  parentId?: string
  playbookRunId?: string | null
  archivedAt?: Date
}): Promise<Row> =>
  prisma.session.create({
    data: {
      ...scope,
      teammateId: teammate.id,
      startedByMemberId: ids.member,
      computerId,
      title: `Thread ${++titles}`,
      origin: data.parentId ? 'child' : 'trigger',
      ...(data.parentId ? { parentTeammateId: teammate.id, awaited: true } : {}),
      ...data,
    },
  })

/** A run of a playbook and its root thread: a customer's mail. */
async function runThread(installationId = support, options: { dryRun?: boolean } = {}) {
  const run = await prisma.playbookRun.create({
    data: { ...scope, installationId, dryRun: options.dryRun ?? false },
  })
  const root = await thread({ title: `Mail ${titles + 1}`, playbookRunId: run.id })
  await prisma.playbookRun.update({ where: { id: run.id }, data: { rootSessionId: root.id } })
  return root
}

/** A run's child that fixes the bug, as start_child makes it: in the run. */
const fixOf = (root: Row) =>
  thread({ title: 'Fix the CSV export', parentId: root.id, playbookRunId: root.playbookRunId })

const call = (session: Row, op: Parameters<typeof handleChildCall>[4]) =>
  handleChildCall(scoped(scope), scope, session, teammate, op) as Promise<Record<string, any>>

const follow = (follower: Row, followed: { id: string }) =>
  call(follower, { name: 'follow_thread', threadId: followed.id })

/** The child calls report, then its turn ends: what the hub does with its events. */
async function reports(child: Row, summary = 'Fixed in #12, merged.') {
  await call(child, { name: 'report', status: 'report', summary })
  await noteChildEvents(child, [
    { event: { type: 'turn.completed', at: new Date().toISOString() } },
  ])
}

/** Someone writes in the child again: a new turn starts. */
const worksAgain = (child: Row) =>
  noteChildEvents(child, [
    { event: { type: 'message.user', at: new Date(Date.now() + 1_000).toISOString() } },
  ])

const notes = async (session: { id: string }) =>
  (
    await prisma.wakeup.findMany({
      where: { sessionId: session.id, kind: 'report' },
      orderBy: { createdAt: 'asc' },
      select: { note: true },
    })
  ).map((w) => w.note)

test('a run follows another run’s child, once', { skip }, async () => {
  const fix = await fixOf(await runThread())
  const mail = await runThread()
  const first = await follow(mail, fix)
  assert.equal(first.error, undefined)
  assert.equal(first.following.threadId, fix.id)
  assert.equal(first.following.waitingForIt, true)
  assert.match(first.note, /woken here once/)
  // Again: still one follow.
  assert.equal((await follow(mail, fix)).error, undefined)
  assert.equal(await prisma.threadFollow.count({ where: { sessionId: fix.id } }), 1)
})

test('follow_thread refuses what it may not follow', { skip }, async () => {
  const root = await runThread()
  const fix = await fixOf(root)
  const mail = await runThread()
  const refused = async (follower: Row, threadId: string, why: RegExp) => {
    const out = await call(follower, { name: 'follow_thread', threadId })
    assert.match(out.error ?? '', why)
  }
  await refused(mail, mail.id, /cannot follow itself/)
  await refused(mail, 'no-such-thread', /No thread of this workspace/)
  await refused(root, fix.id, /your own child/)
  // A run's root thread is no child: it ends with no report.
  await refused(mail, root.id, /Only a child thread/)
  // A thread outside a playbook, or in a dry run.
  await refused(await thread({}), fix.id, /for a playbook’s run/)
  await refused(await runThread(support, { dryRun: true }), fix.id, /for a playbook’s run/)
  // Another playbook's run, or a child outside any playbook.
  await refused(await runThread(otherPlaybook), fix.id, /same playbook/)
  await refused(mail, (await thread({ parentId: (await thread({})).id })).id, /same playbook/)
  // Another workspace's thread is not found at all.
  const elsewhere = await prisma.session.findFirst({
    where: { workspaceId: { not: scope.workspaceId } },
    select: { id: true },
  })
  if (elsewhere) await refused(mail, elsewhere.id, /No thread of this workspace/)
  assert.equal(await prisma.threadFollow.count({ where: { followerId: mail.id } }), 0)
})

test('three runs waiting on one fix are each woken once by its report', { skip }, async () => {
  const root = await runThread()
  const fix = await fixOf(root)
  const mails = [await runThread(), await runThread(), await runThread()]
  for (const mail of mails) assert.equal((await follow(mail, fix)).error, undefined)

  await reports(fix)
  for (const mail of mails) {
    const [note, ...more] = await notes(mail)
    assert.equal(more.length, 0)
    assert.match(note!, /^The thread you follow “Fix the CSV export”/)
    assert.match(note!, /Fixed in #12, merged\./)
    // The dashboard shows it as Brigade's note, not as a person's message.
    assert.equal(childNote(note!), 'follow')
  }
  assert.equal(
    await prisma.threadFollow.count({ where: { sessionId: fix.id, deliveredAt: null } }),
    0,
  )
  // Its own parent heard it too, as before.
  assert.equal((await notes(root)).length, 1)

  // The same report again (events seen twice, a second call): nobody hears it twice.
  await noteChildEvents(fix, [{ event: { type: 'turn.completed', at: new Date().toISOString() } }])
  for (const mail of mails) assert.equal((await notes(mail)).length, 1)
})

test(
  'a wake-up that fails to be stored leaves the follow to the sweep, which wakes it once',
  { skip },
  async () => {
    const fix = await fixOf(await runThread())
    const mail = await runThread()
    const kept = await runThread()
    await follow(mail, fix)
    await follow(kept, fix)
    // The database refuses this follower's wake-up: a failure between claim and wake.
    const name = `fail_wakeup_${id.replace(/-/g, '_')}`
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused'; END $$`,
    )
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER ${name} BEFORE INSERT ON "Wakeup" FOR EACH ROW WHEN (NEW."sessionId" = '${mail.id}') EXECUTE FUNCTION ${name}()`,
    )
    try {
      await reports(fix)
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON "Wakeup"`)
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}()`)
    }
    // Not claimed without its wake-up; the other follower heard it.
    const pending = await prisma.threadFollow.findFirstOrThrow({
      where: { sessionId: fix.id, followerId: mail.id },
    })
    assert.equal(pending.deliveredAt, null)
    assert.equal((await notes(mail)).length, 0)
    assert.equal((await notes(kept)).length, 1)

    // Mid-turn, the sweep leaves it to the turn's end.
    await prisma.session.update({ where: { id: fix.id }, data: { status: 'running' } })
    await settleOverdueChildren()
    assert.equal((await notes(mail)).length, 0)

    // Its turn over: the minute's sweep wakes it, once, however often it runs or the events repeat.
    await prisma.session.update({ where: { id: fix.id }, data: { status: 'idle' } })
    await Promise.all([
      settleOverdueChildren(),
      settleOverdueChildren(),
      noteChildEvents(fix, [{ event: { type: 'turn.completed', at: new Date().toISOString() } }]),
    ])
    await settleOverdueChildren()
    const [note, ...more] = await notes(mail)
    assert.equal(more.length, 0)
    assert.match(note!, /Fixed in #12, merged\./)
    assert.equal((await notes(kept)).length, 1)
    assert.notEqual(
      (
        await prisma.threadFollow.findFirstOrThrow({
          where: { sessionId: fix.id, followerId: mail.id },
        })
      ).deliveredAt,
      null,
    )
  },
)

test('a new report of the followed thread wakes its followers again', { skip }, async () => {
  const fix = await fixOf(await runThread())
  const mail = await runThread()
  await follow(mail, fix)
  await reports(fix, 'A pull request is open: #13.')
  assert.equal((await notes(mail)).length, 1)

  // Reopened (a person wrote in it): its next report is news again.
  await worksAgain(fix)
  assert.equal(
    (await prisma.threadFollow.findFirstOrThrow({ where: { sessionId: fix.id } })).deliveredAt,
    null,
  )
  await reports(fix, 'Merged: #13 is live.')
  const [, second] = await notes(mail)
  assert.match(second!, /Merged: #13 is live\./)
})

test(
  'a thread that already reported is told at once, and woken only by a later report',
  { skip },
  async () => {
    const fix = await fixOf(await runThread())
    await reports(fix, 'Merged: #14.')
    const mail = await runThread()
    const out = await follow(mail, fix)
    assert.equal(out.following.report.summary, 'Merged: #14.')
    assert.equal(out.following.waitingForIt, false)
    assert.match(out.note, /already reported/)
    assert.equal((await notes(mail)).length, 0)
    await worksAgain(fix)
    await reports(fix, 'Reverted, then fixed again: #15.')
    assert.equal((await notes(mail)).length, 1)
  },
)

test(
  'an archived follower comes back with the report; a deleted one is skipped',
  { skip },
  async () => {
    const fix = await fixOf(await runThread())
    const archived = await runThread()
    const deleted = await runThread()
    const kept = await runThread()
    for (const mail of [archived, deleted, kept]) await follow(mail, fix)
    await prisma.session.update({ where: { id: archived.id }, data: { archivedAt: new Date() } })
    await prisma.session.delete({ where: { id: deleted.id } })
    assert.equal(await prisma.threadFollow.count({ where: { sessionId: fix.id } }), 2)

    await reports(fix)
    assert.equal((await notes(archived)).length, 1)
    assert.equal((await notes(kept)).length, 1)
    const back = await prisma.session.findUniqueOrThrow({ where: { id: archived.id } })
    assert.equal(back.archivedAt, null)
    assert.equal(await prisma.wakeup.count({ where: { sessionId: deleted.id } }), 0)
  },
)

test('a cancelled fix tells those following it', { skip }, async () => {
  const root = await runThread()
  const fix = await fixOf(root)
  const mail = await runThread()
  await follow(mail, fix)
  const out = await call(root, { name: 'cancel_child', threadId: fix.id })
  assert.equal(out.error, undefined)
  const [note] = await notes(mail)
  assert.match(note!, /cancelled/)
})

test(`at most ${FOLLOWERS_PER_THREAD} threads follow one`, { skip }, async () => {
  const fix = await fixOf(await runThread())
  for (let i = 0; i < FOLLOWERS_PER_THREAD; i++) {
    const mail = await runThread()
    assert.equal((await follow(mail, fix)).error, undefined)
  }
  const late = await runThread()
  assert.match((await follow(late, fix)).error ?? '', /the most it may/)
  assert.equal(
    await prisma.threadFollow.count({ where: { sessionId: fix.id } }),
    FOLLOWERS_PER_THREAD,
  )
})

test(
  'a follower lists the other runs’ children and reads the one it follows',
  { skip },
  async () => {
    const fix = await fixOf(await runThread())
    const other = await fixOf(await runThread())
    const mail = await runThread()
    const before = await call(mail, { name: 'list_children' })
    const listed = before.fromOtherRuns.filter((c: { threadId: string }) =>
      [fix.id, other.id].includes(c.threadId),
    )
    assert.equal(listed.length, 2)
    assert.ok(listed.every((c: { following: boolean }) => !c.following))

    // Not followed yet: not its to read.
    assert.match(
      (await call(mail, { name: 'read_child', threadId: fix.id })).error ?? '',
      /follows/,
    )
    await follow(mail, fix)
    await reports(fix, 'Fixed in #16.')
    const read = await call(mail, { name: 'read_child', threadId: fix.id })
    assert.equal(read.error, undefined)
    assert.equal(read.report.summary, 'Fixed in #16.')
    assert.match(read.next, /not yours to message/)
    const after = await call(mail, { name: 'list_children' })
    assert.equal(
      after.fromOtherRuns.find((c: { threadId: string }) => c.threadId === fix.id).following,
      true,
    )
    // Outside a playbook, list_children is as it was.
    assert.equal((await call(await thread({}), { name: 'list_children' })).fromOtherRuns, undefined)
  },
)
