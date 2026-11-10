import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import pg from 'pg'

// Wake-ups in a child thread (src/wakeups.ts, src/children.ts) against a real database: a child
// may set one, its report waits for the turn it brings, and its parent waits for it past then.
// The local one of apps/api/.env, in an organization of its own that it removes at the end.
// Without a database to reach, it is skipped.
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
    await client.query('select "report" from "Session" limit 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}
const skip = (await reachable()) ? false : 'no database to reach (apps/api/.env DATABASE_URL)'

const { prisma, scoped } = await import('../src/db.js')
const { handleChildCall, noteChildEvents } = await import('../src/children.js')
const { cancelWakeup, handleWakeup } = await import('../src/wakeups.js')

type Row = Awaited<ReturnType<typeof prisma.session.create>>
const id = randomUUID().slice(0, 8)
const ids = {
  organization: `org-wakeups-${id}`,
  user: `user-wakeups-${id}`,
  member: `mem-wakeups-${id}`,
}
let scope: { organizationId: string; workspaceId: string }
let riley: { id: string; name: string }
let cody: { id: string; name: string }
let computerId: string

before(async () => {
  if (skip) return
  await prisma.organization.create({
    data: { id: ids.organization, name: 'Wake-ups test', slug: ids.organization },
  })
  await prisma.user.create({
    data: { id: ids.user, name: 'Ada', email: `${ids.user}@example.com` },
  })
  await prisma.member.create({
    data: { id: ids.member, organizationId: ids.organization, userId: ids.user, role: 'owner' },
  })
  const workspace = await prisma.workspace.create({
    data: { organizationId: ids.organization, name: 'Wake-ups test' },
  })
  scope = { organizationId: ids.organization, workspaceId: workspace.id }
  for (const name of ['Riley', 'Cody']) {
    const row = await prisma.teammate.create({ data: { ...scope, name } })
    if (name === 'Riley') riley = { id: row.id, name }
    else cody = { id: row.id, name }
  }
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
const thread = (data: object): Promise<Row> =>
  prisma.session.create({
    data: {
      ...scope,
      startedByMemberId: ids.member,
      computerId,
      title: `Thread ${++titles}`,
      status: 'idle',
      ...data,
    } as never,
  })

/** Riley's thread, and the work it handed to Cody in a child it waits for until `awaitUntil`. */
async function family(awaitUntil = new Date(Date.now() + 10 * 60_000)) {
  const parent = await thread({ teammateId: riley.id, origin: 'member' })
  const child = await thread({
    teammateId: cody.id,
    origin: 'child',
    parentId: parent.id,
    parentTeammateId: riley.id,
    awaited: true,
    awaitUntil,
  })
  return { parent, child }
}

/** Cody sets a wake-up in its thread, `minutes` from now. */
const wake = (session: Row, minutes = 120) =>
  handleWakeup(scoped(scope), scope, session, cody, {
    name: 'wake',
    note: 'Check whether the scan is done.',
    minutes,
  }) as Promise<{ wakeupId?: string; error?: string }>

let seq = 0
/** A message in the child: a person's when `memberId` is given. */
async function message(
  child: Row,
  type: 'message.user' | 'message.done',
  text: string,
  memberId?: string,
) {
  await prisma.sessionEvent.create({
    data: {
      ...scope,
      sessionId: child.id,
      seq: ++seq,
      type,
      data: { type, text, ...(memberId ? { memberId } : {}) },
      at: new Date().toISOString(),
    },
  })
}

/** The child's last words, and the end of its turn. */
async function endTurn(child: Row, text: string) {
  await message(child, 'message.done', text)
  await noteChildEvents(child, [
    { event: { type: 'turn.completed', at: new Date().toISOString() } },
  ])
}

const notes = async (session: { id: string }) =>
  (
    await prisma.wakeup.findMany({
      where: { sessionId: session.id, kind: 'report' },
      orderBy: { createdAt: 'asc' },
      select: { note: true },
    })
  ).map((w) => w.note)

const state = (child: Row) =>
  prisma.session.findUniqueOrThrow({
    where: { id: child.id },
    select: { report: true, reportDeliveredAt: true, reportDueAt: true, awaitUntil: true },
  })

test("a child sets a wake-up; a schedule's or a trigger's run does not", { skip }, async () => {
  const { child } = await family()
  assert.ok((await wake(child)).wakeupId)
  for (const origin of ['schedule', 'trigger']) {
    const run = await thread({ teammateId: cody.id, origin })
    assert.match((await wake(run)).error ?? '', /only in a thread a person started or in a child/)
  }
})

test('a child holds its report for the turn its wake-up brings', { skip }, async () => {
  const { parent, child } = await family()
  const set = await wake(child, 120)
  assert.ok(set.wakeupId)
  // Its parent waits for it past the wake-up.
  const before = await state(child)
  assert.ok(before.awaitUntil!.getTime() >= Date.now() + 120 * 60_000)

  // The end of its turn sends nothing, and report waits too.
  await endTurn(child, 'The scan runs; I check it in two hours.')
  assert.deepEqual(await notes(parent), [])
  assert.equal((await state(child)).reportDeliveredAt, null)
  const refused = (await handleChildCall(scoped(scope), scope, child, cody, {
    name: 'report',
    status: 'report',
    summary: 'Not yet.',
  })) as { error?: string }
  assert.match(refused.error ?? '', /wake-up still to come/)

  // It fires: the turn it brings reports.
  await prisma.wakeup.updateMany({
    where: { id: set.wakeupId },
    data: { status: 'fired', firedAt: new Date() },
  })
  await endTurn(child, 'The scan is done: 0 findings.')
  const [note, ...more] = await notes(parent)
  assert.equal(more.length, 0)
  assert.match(note!, /0 findings/)
})

test(
  'a person in the child does not send its report while its wake-up is to come',
  { skip },
  async () => {
    const { parent, child } = await family()
    assert.ok((await wake(child)).wakeupId)
    await message(child, 'message.user', 'Check the scan later.', ids.member)
    await endTurn(child, 'I check it in two hours.')
    assert.equal((await state(child)).reportDueAt, null)
    assert.deepEqual(await notes(parent), [])
  },
)

test('a wake-up cancelled from the panel lets the held child report', { skip }, async () => {
  const { parent, child } = await family()
  const set = await wake(child)
  await endTurn(child, 'The scan runs; I check it in two hours.')
  assert.deepEqual(await notes(parent), [])
  await cancelWakeup(
    scoped(scope),
    { ...scope, memberId: ids.member, userId: ids.user, role: 'owner' },
    child,
    set.wakeupId!,
  )
  const [note] = await notes(parent)
  assert.match(note!, /I check it in two hours/)
})
