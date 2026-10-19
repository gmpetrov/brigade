import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import pg from 'pg'

// A person talking with a child thread (src/children.ts) against a real database: the local one
// of apps/api/.env, in an organization of its own that it removes at the end. Without a database
// to reach, it is skipped.
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
    await client.query('select "reportDueAt" from "Session" limit 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}
const skip = (await reachable()) ? false : 'no database to reach (apps/api/.env DATABASE_URL)'

const { forPeople, noteThreads, REPORT_AFTER_PERSON_MINUTES } = await import('@brigade/contracts')
const { prisma, scoped } = await import('../src/db.js')
const { handleChildCall, noteChildEvents, reportConversation, settleOverdueChildren } =
  await import('../src/children.js')

type Row = Awaited<ReturnType<typeof prisma.session.create>>
const id = randomUUID().slice(0, 8)
const ids = {
  organization: `org-talk-${id}`,
  user: `user-talk-${id}`,
  member: `mem-talk-${id}`,
}
let scope: { organizationId: string; workspaceId: string }
let teammate: { id: string; name: string }
let computerId: string

before(async () => {
  if (skip) return
  await prisma.organization.create({
    data: { id: ids.organization, name: 'Talk test', slug: ids.organization },
  })
  await prisma.user.create({
    data: { id: ids.user, name: 'Ada', email: `${ids.user}@example.com` },
  })
  await prisma.member.create({
    data: { id: ids.member, organizationId: ids.organization, userId: ids.user, role: 'owner' },
  })
  const workspace = await prisma.workspace.create({
    data: { organizationId: ids.organization, name: 'Talk test' },
  })
  scope = { organizationId: ids.organization, workspaceId: workspace.id }
  const riley = await prisma.teammate.create({ data: { ...scope, name: 'Riley' } })
  teammate = { id: riley.id, name: riley.name }
  // Offline: a parent's wake-up is stored and waits, as it would.
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
})

after(async () => {
  if (skip) return
  await prisma.organization.deleteMany({ where: { id: ids.organization } })
  await prisma.user.deleteMany({ where: { id: ids.user } })
  await prisma.$disconnect()
})

let titles = 0
const thread = (parentId?: string): Promise<Row> =>
  prisma.session.create({
    data: {
      ...scope,
      teammateId: teammate.id,
      startedByMemberId: ids.member,
      computerId,
      title: `Thread ${++titles}`,
      origin: parentId ? 'child' : 'member',
      status: 'idle',
      // As the Parallel button starts one: its parent does not wait for it.
      ...(parentId ? { parentId, parentTeammateId: teammate.id, awaited: false } : {}),
    },
  })

/** A parent and its child, started without waiting for it. */
async function family() {
  const parent = await thread()
  return { parent, child: await thread(parent.id) }
}

let seq = 0
const at = (minutes = 0) => new Date(Date.now() + minutes * 60_000).toISOString()

/** A turn in the child: a message (a person's, or Brigade's when memberId is null), its answer, its end. */
async function turn(child: Row, memberId: string | null, answer: string, minutes = 0) {
  const store = (type: string, data: object) =>
    prisma.sessionEvent.create({
      data: { ...scope, sessionId: child.id, seq: ++seq, type, data, at: at(minutes) },
    })
  await store('message.user', { type: 'message.user', text: 'Hi', memberId })
  await noteChildEvents(child, [{ event: { type: 'message.user', at: at(minutes) } }])
  await store('message.done', { type: 'message.done', text: answer })
  await noteChildEvents(child, [{ event: { type: 'turn.completed', at: at(minutes) } }])
}

const notes = async (session: { id: string }) =>
  (
    await prisma.wakeup.findMany({
      where: { sessionId: session.id, kind: 'report' },
      orderBy: { createdAt: 'asc' },
      select: { note: true },
    })
  ).map((w) => w.note)

const row = (child: Row) =>
  prisma.session.findUniqueOrThrow({
    where: { id: child.id },
    select: { report: true, reportDueAt: true, reportDeliveredAt: true },
  })

test('the turn its parent started reports at once, as before', { skip }, async () => {
  const { parent, child } = await family()
  await turn(child, null, 'Six designs: 1 to 6. I recommend 3.', -120)
  const sent = await notes(parent)
  assert.equal(sent.length, 1)
  assert.match(sent[0]!, /^Your child thread “Thread \d+” \(\w+, Riley\) reports:\n\nSix designs/)
  // It never waited for it: no word of a wait that ran out.
  assert.doesNotMatch(sent[0]!, /stopped waiting/)
})

test('a person talking with the child does not wake the parent', { skip }, async () => {
  const { parent, child } = await family()
  await turn(child, null, 'Six designs.', -120)
  await turn(child, ids.member, 'I would go with 3.')
  assert.equal((await notes(parent)).length, 1)
  const after = await row(child)
  assert.equal(after.report, null)
  assert.ok(after.reportDueAt)
  const due = after.reportDueAt!.getTime() - Date.now()
  assert.ok(Math.abs(due - REPORT_AFTER_PERSON_MINUTES * 60_000) < 60_000)
})

test('report, once the person decides, wakes the parent at once', { skip }, async () => {
  const { parent, child } = await family()
  await turn(child, null, 'Six designs.', -120)
  await turn(child, ids.member, 'I would go with 3.')
  // "Go with 3": the child calls report in that turn.
  await prisma.sessionEvent.create({
    data: {
      ...scope,
      sessionId: child.id,
      seq: ++seq,
      type: 'message.user',
      data: { type: 'message.user', text: 'Go with 3', memberId: ids.member },
      at: at(-1),
    },
  })
  await noteChildEvents(child, [{ event: { type: 'message.user', at: at(-1) } }])
  await handleChildCall(scoped(scope), scope, child, teammate, {
    name: 'report',
    status: 'report',
    summary: 'They picked 3 · Parent photo.',
  })
  await noteChildEvents(child, [{ event: { type: 'turn.completed', at: at() } }])
  const sent = await notes(parent)
  assert.equal(sent.length, 2)
  assert.match(sent[1]!, /They picked 3/)
  assert.equal((await row(child)).reportDueAt, null)
  // Nothing left for the sweep to send.
  await settleOverdueChildren()
  assert.equal((await notes(parent)).length, 2)
})

test('a quiet conversation sends its last message once', { skip }, async () => {
  const { parent, child } = await family()
  await turn(child, null, 'Six designs.', -120)
  // The person's turn ended long enough ago.
  await turn(
    child,
    ids.member,
    'Then 3 it is, with the big call area.',
    -REPORT_AFTER_PERSON_MINUTES - 1,
  )
  await settleOverdueChildren()
  await settleOverdueChildren()
  const sent = await notes(parent)
  assert.equal(sent.length, 2)
  assert.match(sent[1]!, /Then 3 it is/)
  assert.match(sent[1]!, /do not ask them the same again/)
  // People read it without what it tells the teammate.
  const shown = noteThreads(sent[1]!)
  assert.equal(shown?.threads[0]?.id, child.id)
  assert.doesNotMatch(forPeople(sent[1]!), /do not ask them/)
  const after = await row(child)
  assert.equal(after.reportDueAt, null)
  assert.ok(after.reportDeliveredAt)
})

test('writing again before it goes keeps it from going', { skip }, async () => {
  const { parent, child } = await family()
  await turn(child, null, 'Six designs.', -120)
  await turn(child, ids.member, 'I would go with 3.', -REPORT_AFTER_PERSON_MINUTES - 5)
  // The person answers: a new turn starts, and the child works on it.
  await prisma.session.update({ where: { id: child.id }, data: { status: 'running' } })
  await noteChildEvents(child, [{ event: { type: 'message.user', at: at() } }])
  await settleOverdueChildren()
  assert.equal((await notes(parent)).length, 1)
  assert.equal((await row(child)).reportDueAt, null)
  await prisma.session.update({ where: { id: child.id }, data: { status: 'idle' } })
})

test('a person sends it now, once', { skip }, async () => {
  const { parent, child } = await family()
  await turn(child, null, 'Six designs.', -120)
  await turn(child, ids.member, 'Going with 3.')
  assert.equal(await reportConversation(scope, child.id), true)
  assert.equal(await reportConversation(scope, child.id), false)
  const sent = await notes(parent)
  assert.equal(sent.length, 2)
  assert.match(sent[1]!, /Going with 3/)
})

test(
  'an awaited child a person talks with still holds its parent until then',
  { skip },
  async () => {
    const parent = await thread()
    const child = await thread(parent.id)
    await prisma.session.update({
      where: { id: child.id },
      data: { awaited: true, awaitUntil: new Date(Date.now() + 60 * 60_000) },
    })
    await turn(child, ids.member, 'Which one?', -REPORT_AFTER_PERSON_MINUTES - 1)
    assert.equal((await notes(parent)).length, 0)
    await settleOverdueChildren()
    const sent = await notes(parent)
    assert.equal(sent.length, 1)
    assert.match(sent[0]!, /^The child thread you were waiting for has finished:/)
  },
)
