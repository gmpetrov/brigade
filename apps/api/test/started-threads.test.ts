import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'
import type { ScheduleOperation, TaskOperation } from '@brigade/contracts'

// Threads a teammate starts at the top (src/started-threads.ts, docs/hand-offs.md), against the
// API's development database (apps/api/.env), in an organization of its own removed at the end;
// skipped when no database answers:
// - start_thread starts a thread for a teammate, itself by default, on the calling thread's
//   starter's accounts, for whoever asked there, in a project, on the lines of a list it names;
// - message_thread writes in a thread it started, never in another one;
// - an older runner's task tools are answered with what replaced them (src/legacy-tasks.ts);
// - the migration that took the Tasks board away declares done the threads of tasks done.
const envFile = new URL('../.env', import.meta.url)
if (!process.env.DATABASE_URL && existsSync(envFile))
  process.env.DATABASE_URL = parseEnv(readFileSync(envFile, 'utf8')).DATABASE_URL || undefined
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')

const { prisma, scoped } = await import('../src/db.js')
const database = await Promise.race([
  prisma.$queryRaw`select "startedFromId" from "Session" limit 1`.then(() => true),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
]).catch(() => false)

type Sent = { type: string; [key: string]: unknown }
type Heard = { ok?: boolean; error?: string; output?: Record<string, unknown> }

const until = async (check: () => boolean | Promise<boolean>, what: string) => {
  for (let i = 0; i < 200; i++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(`timed out waiting for ${what}`)
}

const BACKLOG = [
  '# Backlog',
  '',
  '## To Do',
  '',
  '* [ ] Write the FAQ',
  '* [ ] Fix the export',
  '',
].join('\n')

describe('threads a teammate starts', { skip: !database && 'no database answers' }, () => {
  const suffix = randomUUID().slice(0, 8)
  const ids = {} as Record<
    | 'org'
    | 'user'
    | 'member'
    | 'workspace'
    | 'computer'
    | 'runner'
    | 'riley'
    | 'cody'
    | 'project'
    | 'from'
    | 'other',
    string
  >
  let db: ReturnType<typeof scoped>
  let scope: { organizationId: string; workspaceId: string }
  let sent: Sent[]
  let close: () => void

  before(async () => {
    const library = await import('../src/library.js')
    ids.org = `org-started-${suffix}`
    ids.user = `user-started-${suffix}`
    ids.member = `m-started-${suffix}`
    await prisma.organization.create({
      data: { id: ids.org, name: 'Started', slug: `started-${suffix}` },
    })
    await prisma.user.create({
      data: { id: ids.user, name: 'Ada', email: `${ids.user}@test.local` },
    })
    await prisma.member.create({
      data: { id: ids.member, organizationId: ids.org, userId: ids.user, role: 'owner' },
    })
    ids.workspace = (
      await prisma.workspace.create({ data: { organizationId: ids.org, name: 'Started' } })
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
    ids.riley = (
      await db.teammate.create({ data: { name: 'Riley', libraryAccess: 'read_write' } } as never)
    ).id
    ids.cody = (await db.teammate.create({ data: { name: 'Cody' } } as never)).id
    ids.project = (await db.project.create({ data: { name: 'Acme' } } as never)).id
    await library.saveLibraryFile(
      db,
      scope,
      { type: 'member', id: ids.member },
      { path: 'Projects/Acme/backlog.md', bytes: new TextEncoder().encode(BACKLOG) },
    )
    const thread = async (title: string) => {
      const session = await db.session.create({
        data: {
          teammateId: ids.riley,
          startedByMemberId: ids.member,
          askedByMemberId: ids.member,
          computerId: ids.computer,
          title,
          status: 'idle',
          origin: 'member',
        } as never,
      })
      await db.threadTeammate.create({
        data: { sessionId: session.id, teammateId: ids.riley } as never,
      })
      return session.id
    }
    ids.from = await thread('Plan the launch')
    ids.other = await thread('Something else')
    sent = []
    close = await connect()
  })

  /** Ada's computer, its runner connected: what it is sent goes in `sent`. */
  async function connect() {
    const { runnerSocket } = await import('../src/hub.js')
    const { PROTOCOL_VERSION } = await import('@brigade/contracts')
    const handle = runnerSocket({ id: ids.runner, computerId: ids.computer, ...scope })
    const ws = { send: (raw: string) => sent.push(JSON.parse(raw)), close: () => {} }
    handle.onMessage(
      JSON.stringify({
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        version: '0.0.0',
        platform: 'linux-x64',
      }),
      ws as never,
    )
    await until(() => sent.some((m) => m.type === 'welcome'), 'the welcome')
    return () => handle.onClose()
  }

  after(async () => {
    close?.()
    if (ids.workspace) await prisma.workspace.deleteMany({ where: { id: ids.workspace } })
    await prisma.libraryObject.deleteMany({ where: { organizationId: ids.org } })
    await prisma.libraryObjectFolder.deleteMany({ where: { organizationId: ids.org } })
    await prisma.member.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.deleteMany({ where: { id: ids.org } })
    await prisma.user.deleteMany({ where: { id: ids.user } })
  })

  /** A schedule call from a thread, as its runner sends it; what the runner heard. */
  async function op(sessionId: string, operation: ScheduleOperation, teammateId = ids.riley) {
    const { handleScheduleCall } = await import('../src/schedules.js')
    let heard: Heard = {}
    await handleScheduleCall(
      { computerId: ids.computer, ...scope },
      { type: 'schedule.call', callId: randomUUID(), sessionId, teammateId, operation } as never,
      (message) => (heard = message as never),
    )
    return heard
  }
  /** A task tool call of a runner before protocol 52; what it heard. */
  async function task(sessionId: string, operation: TaskOperation) {
    const { handleTaskCall } = await import('../src/legacy-tasks.js')
    let heard: Heard = {}
    await handleTaskCall(
      { computerId: ids.computer, ...scope },
      { type: 'task.call', callId: randomUUID(), sessionId, teammateId: ids.riley, operation },
      (message) => (heard = message as never),
    )
    return heard
  }
  /** The prompts its computer was sent for a thread, oldest first. */
  const prompts = (sessionId: string) =>
    sent.filter(
      (m) =>
        m.type === 'thread.prompt' && (m.thread as { sessionId?: string }).sessionId === sessionId,
    ) as (Sent & { text: string; memberId: string | null })[]

  test('start_thread starts a thread at the top for another teammate, on the lines it names', async () => {
    const heard = await op(ids.from, {
      name: 'start_thread',
      title: 'Write the FAQ',
      brief: 'The ten questions customers ask most. Done when it is live.',
      teammate: 'cody',
      list: 'Projects/Acme/backlog.md',
      items: ['Write the FAQ'],
    })
    assert.equal(heard.ok, true, heard.error)
    const threadId = heard.output!.threadId as string
    assert.equal(heard.output!.teammate, 'Cody')
    assert.deepEqual(heard.output!.items, ['Write the FAQ'])
    const thread = await db.session.findFirstOrThrow({ where: { id: threadId } })
    // At the top, not a child: in the sidebar, on Ada's accounts, for her, in the list's project.
    assert.equal(thread.parentId, null)
    assert.equal(thread.origin, 'member')
    assert.equal(thread.startedFromId, ids.from)
    assert.equal(thread.teammateId, ids.cody)
    assert.equal(thread.startedByMemberId, ids.member)
    assert.equal(thread.askedByMemberId, ids.member)
    assert.equal(thread.projectId, ids.project)
    // Its line is its item, before its first turn: marked in the file, linked, in its spec.
    const links = await db.listItemThread.findMany({ where: { sessionId: threadId } })
    assert.equal(links.length, 1)
    const item = await db.listItem.findFirstOrThrow({ where: { id: links[0]!.itemId } })
    assert.equal(item.text, 'Write the FAQ')
    await until(() => prompts(threadId).length > 0, 'its first prompt')
    const prompt = prompts(threadId)[0]!
    // Its first message says who started it and from where; no person typed it.
    assert.equal(prompt.memberId, null)
    assert.equal(
      prompt.text,
      '**Riley** started this thread from the thread “Plan the launch”:\n\n' +
        '**Write the FAQ**\n\nThe ten questions customers ask most. Done when it is live.',
    )
    const items = (prompt.thread as { items?: { id: string }[] }).items
    assert.deepEqual(
      items?.map((i) => i.id),
      [item.id],
    )
  })

  test('start_thread is for itself by default, in the project asked or none', async () => {
    const own = await op(ids.from, {
      name: 'start_thread',
      title: 'Rewrite the pricing page',
      brief: 'It came up while planning the launch.',
      project: null,
    })
    assert.equal(own.ok, true, own.error)
    const thread = await db.session.findFirstOrThrow({
      where: { id: own.output!.threadId as string },
    })
    assert.equal(thread.teammateId, ids.riley)
    assert.equal(thread.projectId, null)
    const named = await op(ids.from, {
      name: 'start_thread',
      title: 'Plan the webinar',
      brief: 'One hour, in December.',
      project: 'acme',
    })
    assert.equal(named.ok, true, named.error)
    assert.equal(
      (await db.session.findFirstOrThrow({ where: { id: named.output!.threadId as string } }))
        .projectId,
      ids.project,
    )
  })

  test('a teammate no one is called is refused, with the team named', async () => {
    const heard = await op(ids.from, {
      name: 'start_thread',
      title: 'x',
      brief: 'y',
      teammate: 'Max',
    })
    assert.equal(heard.ok, false)
    assert.equal(heard.error, 'No teammate is called "Max". The team: Cody, Riley.')
    // A list without its lines, or lines without their list.
    const half = await op(ids.from, {
      name: 'start_thread',
      title: 'x',
      brief: 'y',
      list: 'Projects/Acme/backlog.md',
    })
    assert.match(half.error ?? '', /Give the list/)
  })

  test('message_thread writes in a thread it started, and reopens it; never in another one', async () => {
    const started = await op(ids.from, {
      name: 'start_thread',
      title: 'Fix the export',
      brief: 'Exports fail with a 500.',
      teammate: 'Cody',
    })
    const threadId = started.output!.threadId as string
    await db.session.updateMany({
      where: { id: threadId },
      data: { status: 'idle', doneAt: new Date(), doneByType: 'teammate', doneById: ids.cody },
    })
    const heard = await op(ids.from, {
      name: 'message_thread',
      threadId,
      text: 'Also the PDF export.',
    })
    assert.equal(heard.ok, true, heard.error)
    await until(() => prompts(threadId).length > 1, 'the message')
    const message = prompts(threadId).at(-1)!
    assert.equal(message.memberId, null)
    assert.equal(
      message.text,
      '**Riley** commented from the thread “Plan the launch”:\n\nAlso the PDF export.',
    )
    // New work in it: no longer done.
    assert.equal((await db.session.findFirstOrThrow({ where: { id: threadId } })).doneAt, null)
    // From a thread that did not start it: refused, nothing sent.
    const before = prompts(threadId).length
    const refused = await op(ids.other, { name: 'message_thread', threadId, text: 'Merge it.' })
    assert.equal(refused.ok, false)
    assert.match(refused.error ?? '', /not a child of this thread, nor a thread it started/)
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(prompts(threadId).length, before)
  })

  test("an older runner's task tools are answered with what replaced them", async () => {
    // create_task for a teammate: the thread start_thread starts.
    const created = await task(ids.other, {
      name: 'create',
      title: 'Translate the docs',
      description: 'Into French.',
      priority: 'medium',
      assignee: 'Cody',
    })
    assert.equal(created.ok, true, created.error)
    const thread = await db.session.findFirstOrThrow({
      where: { id: created.output!.threadId as string },
    })
    assert.equal(thread.startedFromId, ids.other)
    assert.equal(thread.teammateId, ids.cody)
    // Its comments go there, as message_thread.
    const comment = await task(ids.other, {
      name: 'comment',
      threadId: thread.id,
      text: 'And Spanish.',
    })
    assert.equal(comment.ok, true, comment.error)
    // For itself: nothing to make, the work is here. In Backlog: no board, a list instead.
    assert.match(
      String((await task(ids.other, SELF as TaskOperation)).output?.note),
      /do the work here/,
    )
    const backlog = await task(ids.other, { ...SELF, assignee: 'none' } as TaskOperation)
    assert.equal(backlog.ok, false)
    assert.match(backlog.error ?? '', /no Tasks board any more.*add_item/)
    // The board read: the team, no task.
    const listed = await task(ids.other, { name: 'list' })
    assert.deepEqual(listed.output!.tasks, [])
    assert.deepEqual(
      (listed.output!.teammates as { name: string }[]).map((t) => t.name),
      ['Cody', 'Riley'],
    )
    // complete_task declares the thread done, as complete_thread would.
    const done = await task(ids.other, {
      name: 'complete',
      summary: 'Docs handed to Cody.',
      deliverables: [],
    })
    assert.equal(done.ok, true, done.error)
    const other = await db.session.findFirstOrThrow({ where: { id: ids.other } })
    assert.ok(other.doneAt)
    assert.equal(other.doneSummary, 'Docs handed to Cody.')
    assert.equal(other.doneById, ids.riley)
  })

  test('the migration declares done the threads of tasks done, by whoever completed them', async () => {
    const thread = async (title: string, done?: Date) =>
      (
        await db.session.create({
          data: {
            teammateId: ids.riley,
            startedByMemberId: ids.member,
            computerId: ids.computer,
            title,
            status: 'idle',
            ...(done ? { doneAt: done, doneSummary: 'Its own', doneByType: 'member' } : {}),
            doneById: done ? ids.member : null,
          } as never,
        })
      ).id
    const taskOf = async (sessionId: string, completedAt: Date | null, summary: string | null) => {
      const row = await db.task.create({
        data: { title: 'T', createdByMemberId: ids.member, completedAt, summary } as never,
      })
      await db.session.updateMany({ where: { id: sessionId }, data: { taskId: row.id } })
      return row.id
    }
    const at = new Date('2026-11-01T10:00:00Z')
    const byTeammate = await thread('Completed by Riley')
    const t1 = await taskOf(byTeammate, at, 'Shipped   the\nfix. '.repeat(40))
    await db.auditEntry.create({
      data: {
        actorType: 'teammate',
        actorId: ids.riley,
        action: 'task.completed',
        targetType: 'task',
        targetId: t1,
      } as never,
    })
    const byNobody = await thread('Settled on merge, long ago')
    await taskOf(byNobody, at, null)
    const open = await thread('Still going')
    await taskOf(open, null, null)
    const own = await thread('Done on its own', new Date('2026-11-02T10:00:00Z'))
    await taskOf(own, at, 'From the task')

    const sql = readFileSync(
      new URL('../prisma/migrations/20261105230000_tasks_gone/migration.sql', import.meta.url),
      'utf8',
    )
    const backfill = sql.slice(sql.indexOf('WITH completed AS'))
    await prisma.$executeRawUnsafe(backfill)
    // Twice: the second changes nothing.
    await prisma.$executeRawUnsafe(backfill)

    const row = (id: string) => db.session.findFirstOrThrow({ where: { id } })
    const a = await row(byTeammate)
    assert.deepEqual([a.doneAt, a.doneByType, a.doneById], [at, 'teammate', ids.riley])
    assert.equal(a.doneSummary?.length, 300)
    assert.match(a.doneSummary ?? '', /^Shipped the fix\. Shipped the fix\./)
    const b = await row(byNobody)
    assert.deepEqual(
      [b.doneAt, b.doneByType, b.doneById, b.doneSummary],
      [at, 'system', 'brigade', null],
    )
    assert.equal((await row(open)).doneAt, null)
    const c = await row(own)
    assert.deepEqual(
      [c.doneAt, c.doneSummary, c.doneByType],
      [new Date('2026-11-02T10:00:00Z'), 'Its own', 'member'],
    )
  })
})

const SELF = {
  name: 'create',
  title: 'Write the summary',
  description: '',
  priority: 'medium',
  assignee: 'self',
} as const
