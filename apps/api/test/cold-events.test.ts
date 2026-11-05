import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import pg from 'pg'
import { sessionStub } from './session-stub.js'

// A quiet thread's events kept cold (src/cold-events.ts), and what threads write counted as it is
// stored (src/event-volume.ts), against a real database: the local one of apps/api/.env, with
// its migrations applied, in an organization of its own that it removes at the end. The bucket
// is a folder of its own. Without a database to reach, it is skipped.
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
const bucket = await mkdtemp(join(tmpdir(), 'cold-events-'))
process.env.BUCKET_DIR = bucket

async function reachable() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  })
  try {
    await client.connect()
    await client.query('select 1 from "ColdEventChunk" limit 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}
const skip = (await reachable()) ? false : 'no database to reach (apps/api/.env DATABASE_URL)'

const { prisma, scoped } = await import('../src/db.js')
const { dueColdEvents, goesCold, keepEventsCold, sequenced, threadEvents } =
  await import('../src/cold-events.js')
const { historyContext, pageEvents, pageStart, threadPrompts } =
  await import('../src/thread-history.js')
const { runLog } = await import('../src/timeline.js')
const { coldEventsKey } = await import('../src/bucket.js')

/** Chunks of at most 20 events: a thread of a few turns makes several. */
const SMALL = { events: 20, bytes: 1_000_000, runMs: 60_000, threads: 50 }

const id = randomUUID().slice(0, 8)
const ids = {
  organization: `org-cold-${id}`,
  user: `user-cold-${id}`,
  member: `mem-cold-${id}`,
}
let scope: { organizationId: string; workspaceId: string }
let teammateId: string
let computerId: string

type Event = Record<string, unknown> & { type: string }

/** A thread's work, turn after turn, of every kind of event: those that go cold and those that stay. */
function work(turns: number, first = 0): Event[] {
  const events: Event[] = []
  for (let t = first; t < first + turns; t++) {
    events.push({
      type: 'message.user',
      text: `Question ${t}`,
      memberId: ids.member,
      messageId: `q${t}`,
    })
    events.push({ type: 'turn.started', teammateId })
    for (let i = 0; i < 6; i++)
      events.push({ type: 'message.delta', id: `r${t}`, text: `part ${i} ` })
    events.push({ type: 'raw', source: 'reasoning', value: `Thinking about ${t}` })
    events.push({
      type: 'tool.started',
      toolCallId: `b${t}`,
      toolName: 'Bash',
      input: { command: `ls ${t}` },
    })
    events.push({
      type: 'tool.finished',
      toolCallId: `b${t}`,
      toolName: 'Bash',
      output: { output: `line ${t}\n`.repeat(300) },
      isError: false,
    })
    events.push({
      type: 'raw',
      source: 'harness',
      value: {
        type: 'assistant',
        parent_tool_use_id: 'toolu_1',
        message: { content: [{ type: 'text', text: `Sub-agent ${t}` }] },
      },
    })
    events.push({ type: 'raw', source: 'note', value: `A note ${t}` })
    if (t === 1) {
      const call = { toolCallId: `s${t}`, toolName: 'mcp__harness-tools__save_to_library' }
      events.push({ type: 'tool.started', ...call, input: { path: 'Projects/report.md' } })
      events.push({ type: 'tool.finished', ...call, output: { saved: true }, isError: false })
      events.push({ type: 'file.changed', path: 'report.md', toolName: 'Write' })
    }
    events.push({ type: 'message.done', id: `r${t}`, text: `Answer ${t}, in report.pdf` })
    if (t === first + turns - 1) {
      const card = { toolCallId: `r${t}:suggest_replies`, toolName: 'suggest_replies' }
      events.push({ type: 'tool.started', ...card, input: { replies: ['Go on'] } })
      events.push({ type: 'tool.finished', ...card, output: { shown: 1 }, isError: false })
      events.push({ type: 'preview.changed', status: 'running', url: 'https://p.example' })
    }
    events.push({ type: 'turn.completed', teammateId })
  }
  return events
}

const at0 = new Date('2026-09-01T10:00:00Z')

/** Stored as the API stores them, from `firstSeq` on; the thread's lastSeq over them. */
async function store(sessionId: string, events: Event[], firstSeq = 1) {
  await prisma.sessionEvent.createMany({
    data: events.map((event, i) => {
      const at = new Date(+at0 + (firstSeq + i) * 1000)
      return {
        ...scope,
        sessionId,
        seq: firstSeq + i,
        type: event.type,
        data: { at: at.toISOString(), ...event },
        at,
      }
    }),
  })
  await prisma.session.update({
    where: { id: sessionId },
    data: { lastSeq: firstSeq + events.length - 1 },
  })
}

/** Quiet for `days` (updatedAt is when it last changed). */
const quiet = (sessionId: string, days = 40) =>
  prisma.$executeRaw`UPDATE "Session" SET "updatedAt" = ${new Date(Date.now() - days * 86_400_000)} WHERE "id" = ${sessionId}`

async function newThread(title: string, status: 'idle' | 'running' | 'waiting' = 'idle') {
  return (
    await prisma.session.create({
      data: {
        ...scope,
        teammateId,
        startedByMemberId: ids.member,
        computerId,
        title,
        status,
        origin: 'member',
      },
    })
  ).id
}

const thread = (sessionId: string) =>
  prisma.session.findUniqueOrThrow({
    where: { id: sessionId },
    select: { coldSeq: true, lastSeq: true },
  })
const chunksOf = (sessionId: string) =>
  prisma.coldEventChunk.findMany({ where: { sessionId }, orderBy: { firstSeq: 'asc' } })
const seqsInDatabase = async (sessionId: string) =>
  (
    await prisma.sessionEvent.findMany({
      where: { sessionId },
      orderBy: { seq: 'asc' },
      select: { seq: true },
    })
  ).map((r) => r.seq)

/** What the dashboard and the run log read of a thread. */
async function reads(sessionId: string) {
  const { lastSeq } = await thread(sessionId)
  const firstSeq = await pageStart(sessionId, lastSeq + 1)
  return {
    all: await pageEvents(sessionId, 1, lastSeq + 1),
    page: await pageEvents(sessionId, 15, 45),
    firstSeq,
    context: await historyContext(sessionId, firstSeq),
    later: await historyContext(sessionId, lastSeq - 3),
    prompts: await threadPrompts(sessionId),
    log: await runLog(scoped(scope), sessionId),
  }
}

describe('cold events', { skip }, () => {
  before(async () => {
    await prisma.organization.create({
      data: { id: ids.organization, name: 'Cold events', slug: ids.organization },
    })
    await prisma.user.create({
      data: { id: ids.user, name: 'Member', email: `${ids.user}@example.com` },
    })
    await prisma.member.create({
      data: { id: ids.member, organizationId: ids.organization, userId: ids.user, role: 'owner' },
    })
    const workspace = await prisma.workspace.create({
      data: { organizationId: ids.organization, name: 'Cold events' },
    })
    scope = { organizationId: ids.organization, workspaceId: workspace.id }
    teammateId = (await prisma.teammate.create({ data: { ...scope, name: 'Riley' } })).id
    computerId = (
      await prisma.computer.create({
        data: { ...scope, kind: 'member_machine', memberId: ids.member, name: 'Laptop' },
      })
    ).id
  })

  after(async () => {
    if (skip) return
    await prisma.workspace.deleteMany({ where: { organizationId: ids.organization } })
    await prisma.member.deleteMany({ where: { organizationId: ids.organization } })
    await prisma.organization.deleteMany({ where: { id: ids.organization } })
    await prisma.user.deleteMany({ where: { id: ids.user } })
    await rm(bucket, { recursive: true, force: true })
  })

  test('only threads quiet long enough, and not at work, are due', async () => {
    const recent = await newThread('Recent')
    await store(recent, work(1))
    const running = await newThread('Running', 'running')
    await store(running, work(1))
    await quiet(running)
    const due = await dueColdEvents(new Date())
    assert.ok(!due.includes(scope.workspaceId), 'a recent thread and one at work are not due')
    const quietOne = await newThread('Quiet')
    await store(quietOne, work(1))
    await quiet(quietOne)
    assert.ok((await dueColdEvents(new Date())).includes(scope.workspaceId))
    await keepEventsCold(scope.workspaceId, new Date(), SMALL)
    assert.equal((await thread(recent)).coldSeq, 0)
    assert.equal((await thread(running)).coldSeq, 0)
    assert.equal((await thread(quietOne)).coldSeq, (await thread(quietOne)).lastSeq)
    assert.ok(!(await dueColdEvents(new Date())).includes(scope.workspaceId), 'nothing left due')
    await prisma.session.deleteMany({ where: { id: { in: [recent, running, quietOne] } } })
  })

  test("a quiet thread's heavy events go to the bucket, and it reads the same", async () => {
    const sessionId = await newThread('A long thread')
    const events = work(4)
    await store(sessionId, events)
    await quiet(sessionId)
    const before = await reads(sessionId)
    assert.equal(before.all.length, events.length)
    const updatedAt = async () =>
      (await prisma.session.findUniqueOrThrow({ where: { id: sessionId } })).updatedAt

    const quietSince = await updatedAt()
    const { chunks, moved } = await keepEventsCold(scope.workspaceId, new Date(), SMALL)
    // Its place in the lists, by when it last changed, stays where it was.
    assert.deepEqual(await updatedAt(), quietSince)
    const heavy = events.flatMap((e, i) => (goesCold(e.type, e) ? [i + 1] : []))
    assert.equal(moved, heavy.length)
    assert.equal(chunks, Math.ceil(events.length / SMALL.events))
    assert.deepEqual(await thread(sessionId), { coldSeq: events.length, lastSeq: events.length })

    // Every event in one chunk or another, in a row; each chunk's file in the thread's folder.
    const kept = await chunksOf(sessionId)
    assert.equal(kept[0]!.firstSeq, 1)
    for (const [i, chunk] of kept.entries()) {
      if (i > 0) assert.equal(chunk.firstSeq, kept[i - 1]!.lastSeq + 1)
      assert.equal(chunk.events, chunk.lastSeq - chunk.firstSeq + 1)
      assert.ok(chunk.storedBytes > 0 && chunk.storedBytes < chunk.bytes, 'gzipped')
    }
    assert.equal(kept.at(-1)!.lastSeq, events.length)
    assert.equal(
      kept.reduce((n, c) => n + c.moved, 0),
      heavy.length,
    )
    const folder = join(
      bucket,
      scope.organizationId,
      scope.workspaceId,
      'thread-files',
      sessionId,
      'events',
    )
    assert.deepEqual(
      (await readdir(folder)).sort(),
      kept.map((c) => `${c.firstSeq}-${c.lastSeq}.${c.attempt}.jsonl.gz`).sort(),
    )

    // The database keeps what everything else reads: messages, turns, notes, what it made, its card.
    const stay = events.flatMap((e, i) => (goesCold(e.type, e) ? [] : [i + 1]))
    assert.deepEqual(await seqsInDatabase(sessionId), stay)
    const kindOf = (e: Event) =>
      e.type.startsWith('tool.')
        ? `${e.type}:${String(e.toolName)}`
        : e.type === 'raw'
          ? `raw:${String(e.source)}`
          : e.type
    const types = new Set(stay.map((seq) => kindOf(events[seq - 1]!)))
    for (const kind of [
      'message.user',
      'message.done',
      'turn.started',
      'turn.completed',
      'raw:note',
      'tool.started:mcp__harness-tools__save_to_library',
      'tool.finished:mcp__harness-tools__save_to_library',
      'tool.started:suggest_replies',
      'file.changed',
      'preview.changed',
    ])
      assert.ok(types.has(kind), `${kind} stays`)
    for (const kind of ['message.delta', 'tool.started:Bash', 'raw:harness', 'raw:reasoning'])
      assert.ok(![...types].some((t) => t.startsWith(kind)), `${kind} goes`)

    // Pages (also one across chunks), their context, the timeline and the run log, as before.
    assert.deepEqual(await reads(sessionId), before)
  })

  test("the thread's routes answer the same once it is kept cold: its pages and its log", async () => {
    const sessionId = await newThread('Routes')
    const events = work(4)
    await store(sessionId, events)
    await quiet(sessionId)
    const { auth } = await import('../src/auth.js')
    const { threads } = await import('../src/routes/threads.js')
    const { Hono } = await import('hono')
    const getSession = auth.api.getSession
    ;(auth.api as { getSession: unknown }).getSession = sessionStub(() => ({
      user: { id: ids.user },
      session: {
        id: `s-cold-${id}`,
        activeOrganizationId: scope.organizationId,
        activeWorkspaceId: scope.workspaceId,
      },
    }))
    try {
      const app = new Hono().route('/api/threads', threads)
      const get = async (path: string) => {
        const response = await app.request(`/api/threads/${sessionId}${path}`)
        assert.equal(response.status, 200, await response.clone().text())
        return response.json()
      }
      const paths = ['/events', '/events?from=1', '/events?before=40&since=12', '/log']
      const before = await Promise.all(paths.map(get))
      await keepEventsCold(scope.workspaceId, new Date(), SMALL)
      assert.equal((await thread(sessionId)).coldSeq, events.length)
      assert.deepEqual(await Promise.all(paths.map(get)), before)
      // The first page holds the whole thread here, its kept-cold events among them.
      const all = before[1] as { events: { event: { type: string } }[] }
      assert.equal(all.events.length, events.length)
      assert.ok(all.events.some((e) => e.event.type === 'message.delta'))
    } finally {
      ;(auth.api as { getSession: unknown }).getSession = getSession
    }
  })

  test('a dashboard that follows the thread is sent every event, a batch at a time', async () => {
    const sessionId = await newThread('Followed')
    const events = work(3)
    await store(sessionId, events)
    await quiet(sessionId)
    const all = await pageEvents(sessionId, 1, events.length + 1)
    await keepEventsCold(scope.workspaceId, new Date(), SMALL)
    // One more event after it, in the database.
    const next = { type: 'message.user', text: 'Back', memberId: ids.member, messageId: 'back' }
    await store(sessionId, [next], events.length + 1)
    const { localHub } = await import('../src/hub/memory-host.js')
    const { inHub } = await import('../src/hub/context.js')
    const { onBrowserMessage } = await import('../src/hub/browser-messages.js')
    const hub = localHub(scope.workspaceId)
    const sent: { type: string; [key: string]: unknown }[] = []
    const conn = {
      kind: 'browser' as const,
      id: randomUUID(),
      scope: { ...scope, userId: ids.user, memberId: ids.member, role: 'owner' as const },
      sessions: new Set<string>(),
      visibleUntil: 0,
      terminals: [],
      socket: { send: (text: string) => void sent.push(JSON.parse(text)), close: () => {} },
    }
    hub.browsers.add(conn as never)
    try {
      const follow = (afterSeq: number, tail?: boolean) =>
        inHub(hub, () =>
          onBrowserMessage(
            hub,
            conn as never,
            JSON.stringify({ type: 'subscribe', sessionId, afterSeq, ...(tail ? { tail } : {}) }),
          ),
        )
      await follow(0)
      const replayed = sent.filter((m) => m.type === 'events').flatMap((m) => m.events as unknown[])
      assert.equal(replayed.length, events.length + 1)
      assert.deepEqual(replayed.slice(0, events.length), all)
      assert.ok(
        sent.filter((m) => m.type === 'events').every((m) => (m.events as []).length <= 500),
      )
      // Opened afresh: its latest page and the context before it, those kept cold among them.
      sent.length = 0
      await follow(0, true)
      const history = sent.find((m) => m.type === 'history')!
      const firstSeq = history.firstSeq as number
      assert.deepEqual(history.context, await historyContext(sessionId, firstSeq))
      assert.deepEqual(
        sent.filter((m) => m.type === 'events').flatMap((m) => m.events as unknown[]),
        await pageEvents(sessionId, firstSeq, events.length + 2),
      )
    } finally {
      hub.browsers.delete(conn as never)
    }
  })

  test('events after it come from the database, and are kept cold in turn', async () => {
    const sessionId = await newThread('Back again')
    const first = work(2)
    await store(sessionId, first)
    await quiet(sessionId)
    await keepEventsCold(scope.workspaceId, new Date(), SMALL)
    const more = work(2, 2)
    await store(sessionId, more, first.length + 1)
    const all = first.length + more.length
    const before = await reads(sessionId)
    assert.equal(before.all.length, all)
    assert.deepEqual(
      before.all.map((e) => e.seq),
      Array.from({ length: all }, (_, i) => i + 1),
    )
    // Not quiet yet: nothing more goes.
    await keepEventsCold(scope.workspaceId, new Date(), SMALL)
    assert.equal((await thread(sessionId)).coldSeq, first.length)
    await quiet(sessionId)
    await keepEventsCold(scope.workspaceId, new Date(), SMALL)
    assert.equal((await thread(sessionId)).coldSeq, all)
    const kept = await chunksOf(sessionId)
    for (const [i, chunk] of kept.entries())
      assert.equal(chunk.firstSeq, i === 0 ? 1 : kept[i - 1]!.lastSeq + 1)
    assert.deepEqual(await reads(sessionId), before)
  })

  test('SessionEvent stays append-only, but for what a chunk holds, in its transaction', async () => {
    const sessionId = await newThread('Rules')
    const events = work(1)
    await store(sessionId, events)
    await quiet(sessionId)
    await keepEventsCold(scope.workspaceId, new Date(), SMALL)
    const later = events.length + 1
    await store(sessionId, [{ type: 'message.user', text: 'Later', memberId: ids.member }], later)
    const refused = (sql: () => Promise<unknown>) =>
      assert.rejects(sql, /append-only/, 'refused by the trigger')
    // Never changed.
    await refused(
      () =>
        prisma.$executeRaw`UPDATE "SessionEvent" SET "type" = 'x' WHERE "sessionId" = ${sessionId} AND "seq" = 1`,
    )
    // Never removed outside the transaction that names the thread...
    await refused(
      () =>
        prisma.$executeRaw`DELETE FROM "SessionEvent" WHERE "sessionId" = ${sessionId} AND "seq" = 1`,
    )
    // ...nor in one that names it, past what its chunks hold...
    await refused(() =>
      prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('brigade.cold_session', ${sessionId}, true)`
        await tx.$executeRaw`DELETE FROM "SessionEvent" WHERE "sessionId" = ${sessionId} AND "seq" = ${later}`
      }),
    )
    // ...nor another thread's.
    const other = await newThread('Other')
    await store(other, work(1))
    await refused(() =>
      prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('brigade.cold_session', ${sessionId}, true)`
        await tx.$executeRaw`DELETE FROM "SessionEvent" WHERE "sessionId" = ${other} AND "seq" = 1`
      }),
    )
    // Gone with its thread, as before.
    await prisma.session.delete({ where: { id: other } })
    assert.equal(await prisma.sessionEvent.count({ where: { sessionId: other } }), 0)
  })

  test('a chunk the bucket lost: its range as the database holds it, the rest whole', async () => {
    const sessionId = await newThread('Lost chunk')
    const events = work(3)
    await store(sessionId, events)
    await quiet(sessionId)
    const before = await pageEvents(sessionId, 1, events.length + 1)
    await keepEventsCold(scope.workspaceId, new Date(), SMALL)
    const [, lost] = await chunksOf(sessionId)
    await rm(
      join(bucket, coldEventsKey(scope, sessionId, lost!.firstSeq, lost!.lastSeq, lost!.attempt)),
    )
    const after = await pageEvents(sessionId, 1, events.length + 1)
    const inLost = (seq: number) => seq >= lost!.firstSeq && seq <= lost!.lastSeq
    assert.deepEqual(
      after,
      before.filter((e) => !inLost(e.seq) || !goesCold(e.event.type, e.event)),
    )
    assert.ok(after.length < before.length)
    // Its operators hear of it.
    const { failuresOf } = await import('../src/ops/failures.js')
    assert.ok(
      failuresOf('job:cold-events', 60_000).some((f) => f.workspaceId === scope.workspaceId),
    )
  })

  test('events sent again once kept cold are not stored again', async () => {
    const sessionId = await newThread('Sent again')
    const events = work(1)
    await store(sessionId, events)
    await quiet(sessionId)
    await keepEventsCold(scope.workspaceId, new Date(), SMALL)
    const delta = events.findIndex((e) => e.type === 'message.delta') + 1
    assert.ok(!(await seqsInDatabase(sessionId)).includes(delta))
    const { fakeRunner } = await import('./in-hub.js')
    const { localHub } = await import('../src/hub/memory-host.js')
    const { onRunnerMessage } = await import('../src/hub/runner-messages.js')
    const runner = await fakeRunner(scope, computerId)
    const hub = localHub(scope.workspaceId)
    const conn = hub.runners.get(computerId)!
    try {
      const again = {
        sessionId,
        seq: delta,
        event: { at: new Date().toISOString(), ...events[delta - 1]! },
      }
      await runner.run(() =>
        onRunnerMessage(hub, conn, JSON.stringify({ type: 'events', events: [again] })),
      )
      await conn.queue
      assert.ok(!(await seqsInDatabase(sessionId)).includes(delta), 'not stored again')
      assert.ok(runner.sent.some((m) => m.type === 'ack' && m.seq === events.length))
    } finally {
      for (const timer of conn.retries.values()) clearTimeout(timer)
      runner.close()
    }
  })

  test('two runs at once: each range in one chunk, each event moved once', async () => {
    const sessionId = await newThread('Raced')
    const events = work(3)
    await store(sessionId, events)
    await quiet(sessionId)
    const before = await pageEvents(sessionId, 1, events.length + 1)
    const [one, two] = await Promise.all([
      keepEventsCold(scope.workspaceId, new Date(), SMALL),
      keepEventsCold(scope.workspaceId, new Date(), SMALL),
    ])
    const kept = await chunksOf(sessionId)
    assert.equal(one.chunks + two.chunks, kept.length)
    for (const [i, chunk] of kept.entries())
      assert.equal(chunk.firstSeq, i === 0 ? 1 : kept[i - 1]!.lastSeq + 1)
    assert.equal(kept.at(-1)!.lastSeq, events.length)
    const folder = join(
      bucket,
      scope.organizationId,
      scope.workspaceId,
      'thread-files',
      sessionId,
      'events',
    )
    assert.equal((await readdir(folder)).length, kept.length, 'no copy left over')
    assert.deepEqual(await pageEvents(sessionId, 1, events.length + 1), before)
  })

  test('a read a run overtakes reads from the bucket what left the database', async () => {
    const sessionId = await newThread('Overtaken')
    const events = work(3)
    await store(sessionId, events)
    await quiet(sessionId)
    const before = await pageEvents(sessionId, 1, events.length + 1)
    // The thread is kept cold after the reader saw it was not, before it reads its second batch
    // from the database: that batch's heavy events are gone from there by then.
    const delegate = prisma.sessionEvent
    const findMany = delegate.findMany
    let reads = 0
    delegate.findMany = (async (args: { where?: { sessionId?: unknown }; take?: number }) => {
      if (args.where?.sessionId === sessionId && args.take === 5 && ++reads === 2) {
        delegate.findMany = findMany
        await keepEventsCold(scope.workspaceId, new Date(), SMALL)
      }
      return (findMany as (a: unknown) => Promise<unknown>).call(delegate, args)
    }) as unknown as typeof findMany
    const read = []
    try {
      for await (const rows of threadEvents(sessionId, 1, events.length + 1, { batch: 5 }))
        read.push(...rows)
    } finally {
      delegate.findMany = findMany
    }
    assert.equal(reads, 2, 'kept cold between its reads')
    assert.equal((await thread(sessionId)).coldSeq, events.length)
    assert.deepEqual(read.map(sequenced), before)
  })

  test('a chunk ends near the size it may hold as JSON, an event too large alone in one', async () => {
    const sessionId = await newThread('Sized')
    const events = work(3)
    await store(sessionId, events)
    await quiet(sessionId)
    const sizes = await prisma.$queryRaw<{ seq: number; size: number }[]>`
      SELECT "seq", octet_length("data"::text)::int AS "size" FROM "SessionEvent"
      WHERE "sessionId" = ${sessionId} ORDER BY "seq"`
    const cap = 3000
    await keepEventsCold(scope.workspaceId, new Date(), { ...SMALL, events: 1000, bytes: cap })
    const kept = await chunksOf(sessionId)
    assert.ok(kept.length > 1)
    for (const chunk of kept) {
      const held = sizes.filter((s) => s.seq >= chunk.firstSeq && s.seq <= chunk.lastSeq)
      const total = held.reduce((n, s) => n + s.size, 0)
      assert.ok(total <= cap || held.length === 1, `chunk ${chunk.firstSeq}-${chunk.lastSeq}`)
    }
    assert.equal((await thread(sessionId)).coldSeq, events.length)
    assert.equal((await pageEvents(sessionId, 1, events.length + 1)).length, events.length)
  })

  test('a chunk is bounded by its events as JSON, not as the database compresses them', async () => {
    const sessionId = await newThread('Compressible outputs')
    // A log repeated over 320 kB: a few kB once the database compressed it.
    const output = 'a line of repetitive log output\n'.repeat(10_000)
    const events: Event[] = Array.from({ length: 30 }, (_, i) => ({
      type: 'tool.finished',
      toolCallId: `log-${i}`,
      toolName: 'Bash',
      output,
      isError: false,
    }))
    await store(sessionId, events)
    await quiet(sessionId)
    const cap = 1_000_000
    const [stored] = await prisma.$queryRaw<{ bytes: number }[]>`
      SELECT sum(pg_column_size("data"))::int AS "bytes" FROM "SessionEvent"
      WHERE "sessionId" = ${sessionId}`
    assert.ok(stored!.bytes < cap, 'all of them fit under the cap as the database stores them')
    await keepEventsCold(scope.workspaceId, new Date(), { ...SMALL, events: 1000, bytes: cap })
    const kept = await chunksOf(sessionId)
    for (const chunk of kept)
      assert.ok(chunk.bytes <= cap || chunk.events === 1, `${chunk.bytes} bytes in a chunk`)
    assert.ok(kept.length >= 10, `${kept.length} chunks for 9.6 MB of JSON`)
    assert.equal((await thread(sessionId)).coldSeq, events.length)
    assert.equal((await pageEvents(sessionId, 1, events.length + 1)).length, events.length)
  })

  test("a run overtaken between choosing its chunk and reading it never spoils the winner's", async () => {
    const sessionId = await newThread('Delayed run')
    const events = work(1)
    await store(sessionId, events)
    await quiet(sessionId)
    const before = await pageEvents(sessionId, 1, events.length + 1)
    // The first run has chosen where its chunk ends; another keeps it all cold before it reads it.
    const delegate = prisma.sessionEvent
    const findMany = delegate.findMany
    let overtaken = false
    delegate.findMany = (async (args: { where?: { sessionId?: unknown }; take?: number }) => {
      if (args.where?.sessionId === sessionId && args.take === undefined && !overtaken) {
        overtaken = true
        delegate.findMany = findMany
        await keepEventsCold(scope.workspaceId, new Date(), SMALL)
      }
      return (findMany as (a: unknown) => Promise<unknown>).call(delegate, args)
    }) as unknown as typeof findMany
    try {
      await keepEventsCold(scope.workspaceId, new Date(), SMALL)
    } finally {
      delegate.findMany = findMany
    }
    assert.ok(overtaken)
    assert.deepEqual(await pageEvents(sessionId, 1, events.length + 1), before)
    const kept = await chunksOf(sessionId)
    const folder = join(
      bucket,
      scope.organizationId,
      scope.workspaceId,
      'thread-files',
      sessionId,
      'events',
    )
    assert.deepEqual(
      (await readdir(folder)).sort(),
      kept.map((c) => `${c.firstSeq}-${c.lastSeq}.${c.attempt}.jsonl.gz`).sort(),
      "the winner's copies only",
    )
  })

  test('a read whose batch the database returns empty, kept cold meanwhile, reads the bucket', async () => {
    const sessionId = await newThread('Empty batch')
    const events = work(1)
    await store(sessionId, events)
    await quiet(sessionId)
    // Six deltas: all of them leave the database once kept cold.
    const [from, before] = [3, 9]
    assert.ok(events.slice(from - 1, before - 1).every((e) => e.type === 'message.delta'))
    const expected = await pageEvents(sessionId, from, before)
    const delegate = prisma.sessionEvent
    const findMany = delegate.findMany
    let overtaken = false
    delegate.findMany = (async (args: { where?: { sessionId?: unknown }; take?: number }) => {
      if (args.where?.sessionId === sessionId && args.take === 5 && !overtaken) {
        overtaken = true
        delegate.findMany = findMany
        await keepEventsCold(scope.workspaceId, new Date(), SMALL)
      }
      return (findMany as (a: unknown) => Promise<unknown>).call(delegate, args)
    }) as unknown as typeof findMany
    const read = []
    try {
      for await (const rows of threadEvents(sessionId, from, before, { batch: 5 }))
        read.push(...rows)
    } finally {
      delegate.findMany = findMany
    }
    assert.ok(overtaken)
    assert.equal(expected.length, 6)
    assert.deepEqual(read.map(sequenced), expected)
  })

  test('a run whose COMMIT answer is lost keeps its copy, whatever the COMMIT became', async () => {
    const sessionId = await newThread('Commit still running')
    const events = work(1)
    await store(sessionId, events)
    await quiet(sessionId)
    const expected = await pageEvents(sessionId, 1, events.length + 1)
    // The COMMIT is held on the database (a deferred trigger waits on a lock this test holds),
    // while the API's connection to it breaks: the run sees an error, the database goes on.
    const blocker = new pg.Client({ connectionString: process.env.DATABASE_URL })
    const observer = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await blocker.connect()
    await observer.connect()
    const lock = 6942001
    const trigger = `cold_commit_${id}`
    await blocker.query('SELECT pg_advisory_lock($1)', [lock])
    await observer.query(
      `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${lock}); RETURN NEW; END $$`,
    )
    await observer.query(
      `CREATE CONSTRAINT TRIGGER ${trigger} AFTER INSERT ON "ColdEventChunk" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW."sessionId" = '${sessionId}') EXECUTE FUNCTION ${trigger}()`,
    )
    const query = pg.Client.prototype.query
    let armed = true
    let commitPid: number | undefined
    type Pooled = { processID: number; release: (error: Error) => void }
    pg.Client.prototype.query = function (this: Pooled, ...args: unknown[]) {
      const first = args[0] as string | { text?: string } | undefined
      const sql = typeof first === 'string' ? first : first?.text
      if (armed && /^\s*COMMIT\s*$/i.test(sql ?? '')) {
        armed = false
        commitPid = this.processID
        const sent = (query as (...a: unknown[]) => Promise<unknown>).apply(this, args)
        sent.catch(() => undefined)
        return (async () => {
          for (let i = 0; i < 300; i++) {
            const state = await observer.query(
              'SELECT wait_event FROM pg_stat_activity WHERE pid = $1',
              [commitPid],
            )
            if (state.rows[0]?.wait_event === 'advisory') break
            await new Promise((resolve) => setTimeout(resolve, 10))
          }
          const error = Object.assign(new Error('Connection terminated unexpectedly'), {
            code: 'ECONNRESET',
          })
          this.release(error)
          throw error
        })()
      }
      return (query as (...a: unknown[]) => unknown).apply(this, args)
    } as typeof query
    const folder = join(
      bucket,
      scope.organizationId,
      scope.workspaceId,
      'thread-files',
      sessionId,
      'events',
    )
    try {
      await keepEventsCold(scope.workspaceId, new Date(), SMALL)
      pg.Client.prototype.query = query
      assert.equal(armed, false, 'its COMMIT was sent')
      const pending = await observer.query(
        'SELECT wait_event FROM pg_stat_activity WHERE pid = $1',
        [commitPid],
      )
      assert.equal(pending.rows[0]?.wait_event, 'advisory', 'the COMMIT is still under way')
      assert.equal((await readdir(folder)).length, 1, 'the copy stays while its COMMIT is unknown')
      const { failuresOf } = await import('../src/ops/failures.js')
      assert.ok(failuresOf('job:cold-events', 60_000).some((f) => /terminated/.test(f.message)))
      // The database commits after all: the thread's events are whole, from the bucket.
      await blocker.query('SELECT pg_advisory_unlock($1)', [lock])
      for (let i = 0; i < 300 && (await thread(sessionId)).coldSeq === 0; i++)
        await new Promise((resolve) => setTimeout(resolve, 10))
      assert.equal((await thread(sessionId)).coldSeq, events.length)
      assert.deepEqual(await pageEvents(sessionId, 1, events.length + 1), expected)
    } finally {
      pg.Client.prototype.query = query
      await blocker.query('SELECT pg_advisory_unlock($1)', [lock]).catch(() => undefined)
      await observer.query(`DROP TRIGGER IF EXISTS ${trigger} ON "ColdEventChunk"`)
      await observer.query(`DROP FUNCTION IF EXISTS ${trigger}()`)
      await blocker.end()
      await observer.end()
    }
  })

  test('a thread that fails holds back none of the others', async () => {
    const failing = await newThread('Failing')
    await store(failing, work(1))
    await quiet(failing, 50)
    const other = await newThread('Next one')
    await store(other, work(1))
    await quiet(other, 40)
    // Its chunks cannot be put in the bucket: a file stands where their folder goes.
    const files = join(bucket, scope.organizationId, scope.workspaceId, 'thread-files', failing)
    await mkdir(files, { recursive: true })
    await writeFile(join(files, 'events'), 'not a folder')
    try {
      await keepEventsCold(scope.workspaceId, new Date(), SMALL)
      assert.equal((await thread(failing)).coldSeq, 0)
      assert.equal((await thread(other)).coldSeq, (await thread(other)).lastSeq)
      const { failuresOf } = await import('../src/ops/failures.js')
      assert.ok(
        failuresOf('job:cold-events', 60_000).some((f) => f.workspaceId === scope.workspaceId),
      )
    } finally {
      await rm(join(files, 'events'), { force: true })
    }
    // Tried again by the next run.
    await keepEventsCold(scope.workspaceId, new Date(), SMALL)
    assert.equal((await thread(failing)).coldSeq, (await thread(failing)).lastSeq)
  })

  test('what threads write is counted once, by workspace and day, and by thread', async () => {
    // A workspace of its own: what the other tests store is not counted in it.
    const workspace = await prisma.workspace.create({
      data: { organizationId: ids.organization, name: 'Volume' },
    })
    const own = { organizationId: ids.organization, workspaceId: workspace.id }
    const teammate = (await prisma.teammate.create({ data: { ...own, name: 'Riley' } })).id
    const computer = (
      await prisma.computer.create({
        data: { ...own, kind: 'member_machine', memberId: ids.member, name: 'Laptop' },
      })
    ).id
    const sessionId = (
      await prisma.session.create({
        data: {
          ...own,
          teammateId: teammate,
          startedByMemberId: ids.member,
          computerId: computer,
          title: 'Counted',
          status: 'idle',
          origin: 'member',
        },
      })
    ).id
    const { fakeRunner } = await import('./in-hub.js')
    const { localHub } = await import('../src/hub/memory-host.js')
    const { onRunnerMessage } = await import('../src/hub/runner-messages.js')
    const runner = await fakeRunner(own, computer)
    const hub = localHub(own.workspaceId)
    const conn = hub.runners.get(computer)!
    const at = new Date().toISOString()
    const batch = (from: number, events: Event[]) =>
      JSON.stringify({
        type: 'events',
        events: events.map((event, i) => ({ sessionId, seq: from + i, event: { at, ...event } })),
      })
    const send = async (message: string) => {
      await runner.run(() => onRunnerMessage(hub, conn, message))
      await conn.queue
    }
    const counted = async (events: number) => {
      for (let i = 0; i < 100; i++) {
        const day = await prisma.workspaceEventDay.findFirst({
          where: { workspaceId: own.workspaceId },
        })
        if ((day?.events ?? 0) >= events) return day!
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      assert.fail(`${events} events never counted`)
    }
    const stored = async () =>
      (
        await prisma.$queryRaw<{ bytes: bigint; largest: number }[]>`
          SELECT sum(pg_column_size("data"))::bigint AS "bytes", max(pg_column_size("data"))::int AS "largest"
          FROM "SessionEvent" WHERE "sessionId" = ${sessionId}`
      )[0]!
    try {
      const first: Event[] = [
        { type: 'message.user', text: 'Count this', memberId: ids.member },
        { type: 'turn.started', teammateId: teammate },
        { type: 'message.delta', id: 'r', text: 'Coun' },
        { type: 'message.delta', id: 'r', text: 'ted.' },
        { type: 'message.done', id: 'r', text: 'Counted.' },
      ]
      await send(batch(1, first))
      let day = await counted(5)
      assert.equal(day.events, 5)
      assert.equal(day.deltas, 2)
      let sizes = await stored()
      assert.equal(day.bytes, sizes.bytes)
      assert.equal(day.largest, sizes.largest)
      assert.equal(
        new Date(day.day).toISOString().slice(0, 10),
        new Date().toISOString().slice(0, 10),
      )
      // Sent again (an ack lost): stored once, counted once.
      await send(batch(1, first))
      await send(batch(6, [{ type: 'turn.completed', teammateId: teammate }]))
      day = await counted(6)
      assert.equal(day.events, 6)
      sizes = await stored()
      assert.equal(day.bytes, sizes.bytes)
      const volume = await prisma.threadEventVolume.findUniqueOrThrow({ where: { sessionId } })
      assert.equal(volume.bytes, sizes.bytes)
      assert.equal(volume.largest, sizes.largest)
    } finally {
      for (const timer of conn.retries.values()) clearTimeout(timer)
      runner.close()
    }
  })
})
