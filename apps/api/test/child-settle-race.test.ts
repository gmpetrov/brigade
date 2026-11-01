import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import pg from 'pg'

// Settles of a parent's awaited children at once (settleAwaited, src/children.ts), against a
// real database: a report coming in as the wait runs out, two settles of one finished batch, a
// child released before its report is claimed. The parent hears each report once, in one note.
// The local database of apps/api/.env, in an organization of its own that it removes at the
// end. Without a database to reach, it is skipped.
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
// The files' bytes, in a folder of the test's own.
process.env.BUCKET_DIR = mkdtempSync(join(tmpdir(), 'child-settle-race-'))

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

const { prisma } = await import('../src/db.js')
const { deliverReport, reportSource, settleAwaited } = await import('../src/children.js')

// Each scoped() client is prisma.$extends(...), and its transactions' clients too: their
// session.findMany and session.updateMany go through a hold first, which can stop a call once it
// is done, until the test lets it go on.
type Hold = { op: string; match: (args: any) => boolean; done: () => void; go: Promise<void> }
const holds: Hold[] = []
const gated = (client: any): any =>
  new Proxy(client, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      if (key === '$transaction')
        return (fn: unknown, ...rest: unknown[]) =>
          typeof fn === 'function'
            ? value.call(
                target,
                (tx: unknown) => (fn as (t: unknown) => unknown)(gated(tx)),
                ...rest,
              )
            : value.call(target, fn, ...rest)
      if (key !== 'session') return value
      return new Proxy(value, {
        get(model, op, r) {
          const fn = Reflect.get(model, op, r)
          if (op !== 'findMany' && op !== 'updateMany') return fn
          return async (a: any) => {
            const result = await fn.call(model, a)
            const i = holds.findIndex((h) => h.op === op && h.match(a))
            if (i >= 0) {
              const [hold] = holds.splice(i, 1)
              hold!.done()
              await hold!.go
            }
            return result
          }
        },
      })
    },
  })
const extend = prisma.$extends.bind(prisma)
;(prisma as any).$extends = (...args: unknown[]) => gated((extend as any)(...args))

function hold(op: string, match: (args: any) => boolean) {
  let go!: () => void
  let done!: () => void
  const wasDone = new Promise<void>((resolve) => (done = resolve))
  holds.push({ op, match, done, go: new Promise<void>((resolve) => (go = resolve)) })
  return { wasDone, go }
}

/** Hold the next read of a parent's awaited children, once it has its rows. */
const holdSettle = (parentId: string) =>
  hold('findMany', (a) => a?.where?.parentId === parentId && a?.where?.awaited === true)

/** Hold the next claim of a child's report, once it is made. */
const holdClaim = () => hold('updateMany', (a) => !!a?.data?.reportDeliveredAt)

/** Whether a promise is still pending a moment from now. */
const pending = (p: Promise<unknown>) =>
  Promise.race([
    p.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 300)),
  ])

const id = randomUUID().slice(0, 8)
const ids = {
  organization: `org-settle-${id}`,
  user: `user-settle-${id}`,
  member: `mem-settle-${id}`,
}
let scope: { organizationId: string; workspaceId: string }
let riley: { id: string; name: string }
let cody: { id: string; name: string }
let computerId: string

before(async () => {
  if (skip) return
  await prisma.organization.create({
    data: { id: ids.organization, name: 'Settle test', slug: ids.organization },
  })
  await prisma.user.create({
    data: { id: ids.user, name: 'Ada', email: `${ids.user}@example.com` },
  })
  await prisma.member.create({
    data: { id: ids.member, organizationId: ids.organization, userId: ids.user, role: 'owner' },
  })
  const workspace = await prisma.workspace.create({
    data: { organizationId: ids.organization, name: 'Settle test' },
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
/** Riley's thread, waiting for Cody's children; their wait ran out a minute ago, unless given. */
async function family(awaitUntil = new Date(Date.now() - 60_000)) {
  const thread = (data: object) =>
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
  const parent = await thread({ teammateId: riley.id, origin: 'member' })
  const awaited = () =>
    thread({
      teammateId: cody.id,
      origin: 'child',
      parentId: parent.id,
      parentTeammateId: riley.id,
      awaited: true,
      awaitUntil,
    })
  const child = await awaited()
  return { parent, child, sibling: awaited }
}

const reportIn = (childId: string) =>
  prisma.session.update({
    where: { id: childId },
    data: {
      report: { status: 'report', summary: 'Found the cause.', at: new Date().toISOString() },
    },
  })

const wakeups = (parentId: string) =>
  prisma.wakeup.findMany({
    where: { sessionId: parentId, kind: 'report' },
    orderBy: { createdAt: 'asc' },
    select: { note: true, sourceId: true },
  })

test('a report that comes in as the wait runs out reaches the parent once', { skip }, async () => {
  const { parent, child } = await family()
  // The wait's settle reads the child before its report, and holds the parent's lock.
  const wait = holdSettle(parent.id)
  const waitDone = settleAwaited(scope, parent.id)
  await wait.wasDone
  await reportIn(child.id)
  // The report's delivery waits for the lock: it reads the child once the wait's settle is done.
  const deliveryDone = deliverReport(scope, child.id)
  assert.equal(await pending(deliveryDone), true)
  wait.go()
  await Promise.all([waitDone, deliveryDone])
  const notes = await wakeups(parent.id)
  assert.equal(notes.length, 1, notes.map((n) => n.note).join('\n---\n'))
  assert.match(notes[0]!.note, /Found the cause\./)
  // Not also told it is still working.
  assert.doesNotMatch(notes[0]!.note, /Still working past the time/)
  const row = await prisma.session.findUniqueOrThrow({
    where: { id: child.id },
    select: { awaited: true, reportDeliveredAt: true },
  })
  // Delivered as awaited: never marked unfinished.
  assert.equal(row.awaited, true)
  assert.ok(row.reportDeliveredAt)
})

test('two settles of a finished batch at once wake the parent once', { skip }, async () => {
  const { parent, child, sibling } = await family(new Date(Date.now() + 3_600_000))
  const other = await sibling()
  await reportIn(child.id)
  await reportIn(other.id)
  // A stops after its first claim, holding the parent's lock; B starts meanwhile.
  const claim = holdClaim()
  const first = settleAwaited(scope, parent.id)
  await claim.wasDone
  const second = settleAwaited(scope, parent.id)
  assert.equal(await pending(second), true)
  claim.go()
  await Promise.all([first, second])
  const notes = await wakeups(parent.id)
  assert.equal(notes.length, 1, 'one wake-up containing both finished reports')
  assert.match(notes[0]!.note, /2 child threads you were waiting for have finished/)
})

test(
  'a child released past the wait before its report is claimed is delivered on its own',
  { skip },
  async () => {
    const { parent, child } = await family()
    await reportIn(child.id)
    const delivery = holdSettle(parent.id)
    const deliveryDone = deliverReport(scope, child.id)
    await delivery.wasDone
    // Meanwhile its wait is let go, as a release past the wait does, before the report is claimed.
    await prisma.session.update({ where: { id: child.id }, data: { awaited: false } })
    delivery.go()
    await deliveryDone
    const notes = await wakeups(parent.id)
    assert.equal(notes.length, 1, notes.map((n) => n.note).join('\n---\n'))
    assert.match(notes[0]!.note, /after you stopped waiting for it/)
    const row = await prisma.session.findUniqueOrThrow({
      where: { id: child.id },
      select: { reportDeliveredAt: true },
    })
    // Its own wake-up, which auto-merge holds the child's pull requests by.
    assert.equal(notes[0]!.sourceId, reportSource(child.id, row.reportDeliveredAt!))
  },
)

test(
  'the wait running out with no report tells the parent once that it is still working',
  { skip },
  async () => {
    const { parent, child } = await family()
    await settleAwaited(scope, parent.id)
    await settleAwaited(scope, parent.id)
    const notes = await wakeups(parent.id)
    assert.equal(notes.length, 1)
    assert.match(notes[0]!.note, /Still working past the time/)
    // Its report, later, comes on its own.
    await reportIn(child.id)
    await deliverReport(scope, child.id)
    const after = await wakeups(parent.id)
    assert.equal(after.length, 2)
    assert.match(after[1]!.note, /after you stopped waiting for it/)
  },
)
