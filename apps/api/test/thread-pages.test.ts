import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import pg from 'pg'

// A thread's pages for its timeline (src/thread-history.ts) against a real database: the
// local one of apps/api/.env, in an organization of its own that it removes at the end.
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
    await client.query('select 1 from "SessionEvent" limit 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}
const skip = (await reachable()) ? false : 'no database to reach (apps/api/.env DATABASE_URL)'

const { prisma } = await import('../src/db.js')
const { pageEnd, pageEvents, startAt, threadPrompts } = await import('../src/thread-history.js')
const { THREAD_PAGE_EVENTS, THREAD_PROMPT_CHARS } = await import('@brigade/contracts')

const id = randomUUID().slice(0, 8)
const ids = {
  organization: `org-pages-${id}`,
  user: `user-pages-${id}`,
  member: `mem-pages-${id}`,
}
let sessionId: string
/** Where each turn's message is: turns of TURN events, a message, its turn, steps, its end. */
const messages: number[] = []
const TURNS = 9
const TURN = 501
const LONG = 'x'.repeat(THREAD_PROMPT_CHARS + 50)

before(async () => {
  if (skip) return
  await prisma.organization.create({
    data: { id: ids.organization, name: 'Pages test', slug: ids.organization },
  })
  await prisma.user.create({
    data: { id: ids.user, name: 'Member', email: `${ids.user}@example.com` },
  })
  await prisma.member.create({
    data: { id: ids.member, organizationId: ids.organization, userId: ids.user, role: 'owner' },
  })
  const workspace = await prisma.workspace.create({
    data: { organizationId: ids.organization, name: 'Pages test' },
  })
  const scope = { organizationId: ids.organization, workspaceId: workspace.id }
  const teammateId = (await prisma.teammate.create({ data: { ...scope, name: 'Riley' } })).id
  const computerId = (
    await prisma.computer.create({
      data: { ...scope, kind: 'member_machine', memberId: ids.member, name: 'Laptop' },
    })
  ).id
  sessionId = (
    await prisma.session.create({
      data: {
        ...scope,
        teammateId,
        startedByMemberId: ids.member,
        computerId,
        title: 'A long thread',
        status: 'idle',
        origin: 'member',
      },
    })
  ).id
  const at = new Date('2026-10-01T10:00:00Z')
  const rows: { seq: number; type: string; data: object }[] = []
  for (let turn = 0; turn < TURNS; turn++) {
    const seq = turn * TURN + 1
    messages.push(seq)
    // Every third message is Brigade's own (a wake-up): not the member's.
    const memberId = turn % 3 === 2 ? null : ids.member
    rows.push({
      seq,
      type: 'message.user',
      data: { type: 'message.user', text: turn === 0 ? LONG : `Message ${turn}`, memberId },
    })
    rows.push({ seq: seq + 1, type: 'turn.started', data: { type: 'turn.started' } })
    for (let step = 2; step < TURN - 1; step++)
      rows.push({ seq: seq + step, type: 'tool.started', data: { type: 'tool.started' } })
    rows.push({ seq: seq + TURN - 1, type: 'turn.completed', data: { type: 'turn.completed' } })
  }
  await prisma.sessionEvent.createMany({
    data: rows.map((r) => ({ ...scope, sessionId, ...r, at: new Date(+at + r.seq * 1000) })),
  })
})

after(async () => {
  if (skip) return
  await prisma.organization.deleteMany({ where: { id: ids.organization } })
  await prisma.user.deleteMany({ where: { id: ids.user } })
  await prisma.$disconnect()
})

test('the timeline lists the member’s messages only, each cut short', { skip }, async () => {
  const prompts = await threadPrompts(sessionId)
  const mine = messages.filter((_, turn) => turn % 3 !== 2)
  assert.deepEqual(
    prompts.map((p) => p.seq),
    mine,
  )
  assert.equal(prompts[0]!.text, LONG.slice(0, THREAD_PROMPT_CHARS))
  assert.equal(prompts[1]!.text, 'Message 1')
  assert.equal(
    prompts[1]!.at,
    new Date(Date.parse('2026-10-01T10:00:00Z') + (TURN + 1) * 1000).toISOString(),
  )
})

test('a page jumped to starts at its message and ends about a page on', { skip }, async () => {
  const target = messages[2]!
  // Inside its turn: the page starts with the message that started it.
  assert.equal(await startAt(sessionId, target + 40), target)
  assert.equal(await startAt(sessionId, 0), 1)
  const last = TURNS * TURN + 1
  const end = await pageEnd(sessionId, target, last)
  // The first message at least a page on: never inside a turn.
  assert.equal(
    end,
    messages.find((seq) => seq >= target + THREAD_PAGE_EVENTS),
  )
  const events = await pageEvents(sessionId, target, end)
  assert.equal(events.length, end - target)
  assert.equal(events[0]!.seq, target)
})

test('a page jumped to stops where the dashboard has the thread already', { skip }, async () => {
  const until = messages[4]!
  assert.equal(await pageEnd(sessionId, messages[1]!, until), until)
  // Near the end, with no message a page on: up to `until`.
  const last = TURNS * TURN + 1
  assert.equal(await pageEnd(sessionId, messages[7]!, last), last)
})
