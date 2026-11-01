import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import pg from 'pg'

// What a child's report brings its parent (src/children.ts) against a real database: the whole
// report, and the files it sends. The local one of apps/api/.env, in an organization of its
// own that it removes at the end. Without a database to reach, it is skipped.
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
process.env.BUCKET_DIR = mkdtempSync(join(tmpdir(), 'child-reports-'))

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

const { noteThreads, REPORT_START } = await import('@brigade/contracts')
const { prisma, scoped } = await import('../src/db.js')
const { storeAttachment, threadAttachments } = await import('../src/attachments.js')
const { handleChildCall, noteChildEvents } = await import('../src/children.js')

type Row = Awaited<ReturnType<typeof prisma.session.create>>
const id = randomUUID().slice(0, 8)
const ids = {
  organization: `org-reports-${id}`,
  user: `user-reports-${id}`,
  member: `mem-reports-${id}`,
}
let scope: { organizationId: string; workspaceId: string }
let riley: { id: string; name: string }
let cody: { id: string; name: string }
let computerId: string

before(async () => {
  if (skip) return
  await prisma.organization.create({
    data: { id: ids.organization, name: 'Reports test', slug: ids.organization },
  })
  await prisma.user.create({
    data: { id: ids.user, name: 'Ada', email: `${ids.user}@example.com` },
  })
  await prisma.member.create({
    data: { id: ids.member, organizationId: ids.organization, userId: ids.user, role: 'owner' },
  })
  const workspace = await prisma.workspace.create({
    data: { organizationId: ids.organization, name: 'Reports test' },
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
/** Riley's thread, and the review it handed to Cody in a child, without waiting for it. */
async function family() {
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
  const parent = await thread({ teammateId: riley.id, origin: 'member' })
  const child = await thread({
    teammateId: cody.id,
    origin: 'child',
    parentId: parent.id,
    parentTeammateId: riley.id,
    awaited: false,
  })
  return { parent, child }
}

/** A file the child's runner sent first, as POST /runner/attachments stores it. */
const upload = (session: Row, name: string, text: string) =>
  storeAttachment(scoped(scope), scope, {
    source: 'teammate',
    sessionId: session.id,
    name,
    bytes: new TextEncoder().encode(text),
  })

let seq = 0
/** The child's last words, and the end of its turn. */
async function endTurn(child: Row, text: string) {
  const at = new Date().toISOString()
  await prisma.sessionEvent.create({
    data: {
      ...scope,
      sessionId: child.id,
      seq: ++seq,
      type: 'message.done',
      data: { type: 'message.done', text },
      at,
    },
  })
  await noteChildEvents(child, [{ event: { type: 'turn.completed', at } }])
}

const notes = async (session: { id: string }) =>
  (
    await prisma.wakeup.findMany({
      where: { sessionId: session.id, kind: 'report' },
      orderBy: { createdAt: 'asc' },
      select: { note: true },
    })
  ).map((w) => w.note)

/** A review of eleven findings, each with where and how to reproduce it: about 9,000 characters. */
const review =
  'Recommend changes: 11 findings (2 P1, 9 P2).\n\n' +
  Array.from(
    { length: 11 },
    (_, i) =>
      `${i + 1}. **[P2] Finding ${i + 1}.** apps/api/src/library.ts:${500 + i}. ` +
      'Why it matters, then the reproduction: '.padEnd(780, 'x'),
  ).join('\n\n')

test('a report brings its parent the whole review and the files it sent', { skip }, async () => {
  const { parent, child } = await family()
  const script = await upload(child, 'bridge-repro.mjs', 'console.log("repro")\n')
  const log = await upload(child, 'run.log', 'ok 1\nnot ok 2\n')
  const answer = await handleChildCall(scoped(scope), scope, child, cody, {
    name: 'report',
    status: 'report',
    summary: review,
    files: [script.id, log.id],
  })
  assert.match(JSON.stringify(answer), /Noted, with its 2 files/)

  // The files are the parent's now: its runner puts them in each teammate's folder.
  const given = await threadAttachments(scoped(scope), parent.id)
  assert.deepEqual(
    given.map((f) => f.path),
    ['attachments/bridge-repro.mjs', 'attachments/run.log'],
  )

  await endTurn(child, 'Reported to Riley.')
  const [note] = await notes(parent)
  assert.ok(note)
  // The note gives the start of it, and where the files are.
  const card = noteThreads(note)!.threads[0]!
  assert.ok(card.summary.startsWith('Recommend changes: 11 findings'))
  assert.ok(card.summary.length < REPORT_START + 200)
  assert.match(
    note,
    /Files it sent \(in your working folder\): `attachments\/bridge-repro\.mjs`, `attachments\/run\.log`\./,
  )

  // read_child gives all of it, the files, and what it said after.
  const read = (await handleChildCall(scoped(scope), scope, parent, riley, {
    name: 'read_child',
    threadId: child.id,
  })) as {
    report: { summary: string }
    files: { path: string; size: number }[]
    lastMessage?: string
  }
  assert.equal(read.report.summary, review)
  assert.deepEqual(
    read.files.map((f) => [f.path, f.size]),
    [
      ['attachments/bridge-repro.mjs', 21],
      ['attachments/run.log', 14],
    ],
  )
  assert.equal(read.lastMessage, 'Reported to Riley.')

  // list_children stays short: each report's start.
  const list = (await handleChildCall(scoped(scope), scope, parent, riley, {
    name: 'list_children',
  })) as { children: { report?: { summary: string } }[] }
  assert.ok(list.children[0]!.report!.summary.length <= REPORT_START)
})

test("a report cannot send another thread's file", { skip }, async () => {
  const { parent, child } = await family()
  const other = await family()
  const theirs = await upload(other.child, 'secret.txt', 'not yours')
  const answer = await handleChildCall(scoped(scope), scope, child, cody, {
    name: 'report',
    status: 'report',
    summary: 'Done.',
    files: [theirs.id],
  })
  assert.match(JSON.stringify(answer), /not found/)
  assert.equal((await threadAttachments(scoped(scope), parent.id)).length, 0)
  const row = await prisma.session.findUniqueOrThrow({
    where: { id: child.id },
    select: { report: true },
  })
  assert.equal(row.report, null)
})

test('a child that ends without a report sends its whole last message', { skip }, async () => {
  const { parent, child } = await family()
  await endTurn(child, review)
  const read = (await handleChildCall(scoped(scope), scope, parent, riley, {
    name: 'read_child',
    threadId: child.id,
  })) as { report: { summary: string }; lastMessage?: string; files?: unknown }
  assert.equal(read.report.summary, review)
  // Not said twice, and no files it did not send.
  assert.equal(read.lastMessage, undefined)
  assert.equal(read.files, undefined)
})

test('a turn stopped and tried again sends no report until the try ends', { skip }, async () => {
  const { parent, child } = await family()
  // What it reported before the computer ran out of memory, its sub-agents still at work.
  await handleChildCall(scoped(scope), scope, child, cody, {
    name: 'report',
    status: 'report',
    summary: 'Half of it.',
  })
  const stopped = 'Stopped to give the computer memory back: it held the most (0.3 GB).'
  await noteChildEvents(child, [
    { event: { type: 'error', at: new Date().toISOString(), message: stopped, retrying: true } },
  ])
  assert.deepEqual(await notes(parent), [])
  const held = await prisma.session.findUniqueOrThrow({
    where: { id: child.id },
    select: { reportDeliveredAt: true },
  })
  assert.equal(held.reportDeliveredAt, null)

  // The try ends: its report goes, once.
  await handleChildCall(scoped(scope), scope, child, cody, {
    name: 'report',
    status: 'report',
    summary: 'All of it.',
  })
  await endTurn(child, 'Reported.')
  const [note, ...more] = await notes(parent)
  assert.equal(more.length, 0)
  assert.match(note!, /All of it\./)
})

test('an error with no try after it sends what the child has', { skip }, async () => {
  const { parent, child } = await family()
  await noteChildEvents(child, [
    { event: { type: 'error', at: new Date().toISOString(), message: 'It broke.' } },
  ])
  const [note] = await notes(parent)
  assert.match(note!, /It broke\./)
})
