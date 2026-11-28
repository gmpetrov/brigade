import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'

// Agent swarms (docs/sub-threads.md) against the API's development database (apps/api/.env), in an
// organization of its own removed at the end; skipped when none answers:
// - a sub-thread starts its own, one level further; a third level is refused;
// - 8 at work per tree over both levels, the 9th refused whatever its level, and two starts at once
//   for the last place take it once;
// - computer: same, cloud, mine (by name among several), never another member's machine; refused
//   at once when offline, too old or with no account there;
// - files and branches travel with the brief;
// - needs_parent wakes the parent at once; wake each wakes it on each report;
// - message_thread within a tree says the relation, and stops at the tree's edge;
// - the Tree section's levels, states and tokens.
const envFile = new URL('../.env', import.meta.url)
if (!process.env.DATABASE_URL && existsSync(envFile))
  process.env.DATABASE_URL = parseEnv(readFileSync(envFile, 'utf8')).DATABASE_URL
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
process.env.BUCKET_DIR = mkdtempSync(join(tmpdir(), 'subthread-trees-'))

const { prisma, scoped, Prisma } = await import('../src/db.js')
const database = await Promise.race([
  prisma.$queryRaw`select "rootId" from "Session" limit 1`.then(() => true),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
]).catch(() => false)

const { SUBTHREADS_AT_WORK, SUBTHREADS_PROTOCOL, fromParent } = await import('@brigade/contracts')
const { handleChildCall, noteChildEvents } = await import('../src/children.js')
const { messageThread } = await import('../src/started-threads.js')
const { threadTree } = await import('../src/thread-tree.js')
const { loadThread, specFor } = await import('../src/thread-spec.js')
const { fakeRunner } = await import('./in-hub.js')

describe('agent swarm sub-threads', { skip: database ? false : 'no database' }, () => {
  const suffix = randomUUID().slice(0, 8)
  const org = `org-swarm-${suffix}`
  const people = ['ada', 'bob'] as const
  const user = (p: string) => `user-swarm-${p}-${suffix}`
  const member = (p: string) => `mem-swarm-${p}-${suffix}`
  let scope: { organizationId: string; workspaceId: string }
  let db: ReturnType<typeof scoped>
  let riley: { id: string; name: string }
  const computers = {} as Record<'laptop' | 'studio' | 'cloud' | 'bobs' | 'old', string>
  const runners: { close: () => void }[] = []

  before(async () => {
    await prisma.organization.create({ data: { id: org, name: 'Swarm', slug: org } })
    for (const p of people) {
      await prisma.user.create({ data: { id: user(p), name: p, email: `${user(p)}@example.com` } })
      await prisma.member.create({
        // Ada owns the workspace; Bob is a member, whom a thread closed to others keeps out.
        data: {
          id: member(p),
          organizationId: org,
          userId: user(p),
          role: p === 'ada' ? 'owner' : 'member',
        },
      })
    }
    const workspace = await prisma.workspace.create({
      data: { organizationId: org, name: 'Swarm' },
    })
    scope = { organizationId: org, workspaceId: workspace.id }
    db = scoped(scope)
    const teammate = await prisma.teammate.create({ data: { ...scope, name: 'Riley' } })
    riley = { id: teammate.id, name: teammate.name }
    const machine = async (name: string, owner: string, kind: 'member_machine' | 'cloud') =>
      (
        await prisma.computer.create({
          data: {
            ...scope,
            kind,
            name,
            ...(kind === 'member_machine' ? { memberId: owner } : { status: 'running' }),
          },
        })
      ).id
    computers.laptop = await machine("Ada's Laptop", member('ada'), 'member_machine')
    computers.studio = await machine("Ada's Studio", member('ada'), 'member_machine')
    computers.bobs = await machine("Bob's Mac", member('bob'), 'member_machine')
    computers.old = await machine("Ada's Old Mac", member('ada'), 'member_machine')
    computers.cloud = await machine('Cloud', member('ada'), 'cloud')
    // Ada's Claude account on each of her computers but the studio; Bob's on his.
    for (const [computer, who] of [
      [computers.laptop, 'ada'],
      [computers.cloud, 'ada'],
      [computers.old, 'ada'],
      [computers.bobs, 'bob'],
    ] as const)
      await prisma.account.create({
        data: {
          ...scope,
          memberId: member(who),
          computerId: computer,
          provider: 'claude_code',
          label: 'Claude',
          status: 'ready',
        },
      })
    // All online, the old Mac on a runner before SUBTHREADS_PROTOCOL.
    for (const id of [computers.laptop, computers.studio, computers.cloud, computers.bobs])
      runners.push(await fakeRunner(scope, id))
    const old = await fakeRunner(scope, computers.old)
    const { localHub } = await import('../src/hub/memory-host.js')
    localHub(scope.workspaceId).runners.get(computers.old)!.protocolVersion =
      SUBTHREADS_PROTOCOL - 1
    runners.push(old)
  })

  after(async () => {
    for (const r of runners) r.close()
    await prisma.organization.deleteMany({ where: { id: org } })
    await prisma.user.deleteMany({ where: { id: { in: people.map(user) } } })
    await prisma.$disconnect()
  })

  let titles = 0
  /** Ada's thread at the top, on her laptop. */
  async function top(computerId = computers.laptop) {
    // No runner here acknowledges what it is sent: what the tests before left queued goes, so that
    // each computer's queue has room (a computer takes so many messages waiting at most).
    await prisma.runnerCommand.deleteMany({ where: { workspaceId: scope.workspaceId } })
    const session = await prisma.session.create({
      data: {
        ...scope,
        teammateId: riley.id,
        startedByMemberId: member('ada'),
        askedByMemberId: member('ada'),
        computerId,
        title: `Launch kit ${++titles}`,
        status: 'idle',
      },
    })
    await prisma.threadTeammate.create({
      data: { ...scope, sessionId: session.id, teammateId: riley.id },
    })
    return session
  }

  const row = (id: string) => prisma.session.findUniqueOrThrow({ where: { id } })

  /** start_child from a thread, as its runner sends it. */
  async function start(
    from: { id: string },
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, any>> {
    return (await handleChildCall(db, scope, await row(from.id), riley, {
      name: 'start_child',
      title: `Part ${++titles}`,
      instructions: 'Do this part. Why a sub-thread: it is independent.',
      wait: true,
      ...extra,
    } as never)) as Record<string, any>
  }

  /** A sub-thread's report, then the end of its turn: what the hub does with its events. */
  async function reports(child: { id: string }, status = 'report', summary = 'Done.') {
    const out = (await handleChildCall(db, scope, await row(child.id), riley, {
      name: 'report',
      status,
      summary,
    } as never)) as Record<string, any>
    assert.equal(out.error, undefined, JSON.stringify(out))
    // Not at work any more, as after its turn.
    await prisma.session.update({ where: { id: child.id }, data: { status: 'idle' } })
    await noteChildEvents(await row(child.id), [
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

  test('a sub-thread starts its own; a third level is refused', async () => {
    const root = await top()
    const one = await start(root)
    assert.ok(one.threadId, JSON.stringify(one))
    assert.equal(one.level, 1)
    const two = await start({ id: one.threadId })
    assert.ok(two.threadId, JSON.stringify(two))
    assert.equal(two.level, 2)
    // Both in the tree of the thread at the top.
    assert.equal((await row(one.threadId)).rootId, root.id)
    assert.equal((await row(two.threadId)).rootId, root.id)
    assert.equal((await row(two.threadId)).parentId, one.threadId)
    const three = await start({ id: two.threadId })
    assert.match(three.error ?? '', /2 levels deep, the most Brigade allows/)
    assert.equal(await prisma.session.count({ where: { parentId: two.threadId } }), 0)
  })

  test(`the ${SUBTHREADS_AT_WORK + 1}th at work in a tree is refused, whatever its level`, async () => {
    const root = await top()
    const first = await start(root)
    const started = [first.threadId as string]
    for (let i = 1; i < SUBTHREADS_AT_WORK; i++) {
      // Half of them under the first sub-thread: they count the same.
      const out = await start(i % 2 ? { id: first.threadId } : root)
      assert.ok(out.threadId, JSON.stringify(out))
      started.push(out.threadId)
    }
    const ninth = await start({ id: first.threadId })
    assert.match(
      ninth.error ?? '',
      new RegExp(`already has ${SUBTHREADS_AT_WORK} sub-threads at work`),
    )
    assert.match((await start(root)).error ?? '', /the most it may/)
    // One reports: a place is free again.
    await reports({ id: started.at(-1)! })
    assert.ok((await start(root)).threadId)
  })

  test('two starts at once for the last place: one takes it', async () => {
    const root = await top()
    for (let i = 0; i < SUBTHREADS_AT_WORK - 1; i++) assert.ok((await start(root)).threadId)
    // Each new row of this tree takes a while to be made: two starts at once both count before
    // either row is in, unless the tree's lock makes the second count after the first's commit.
    const name = `slow_tree_${root.id}`
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.4); RETURN NEW; END $$`,
    )
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER ${name} BEFORE INSERT ON "Session" FOR EACH ROW WHEN (NEW."rootId" = '${root.id}') EXECUTE FUNCTION ${name}()`,
    )
    let both: Record<string, any>[]
    try {
      both = await Promise.all([start(root), start(root)])
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON "Session"`)
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}()`)
    }
    assert.equal(both.filter((o) => o.threadId).length, 1, JSON.stringify(both))
    assert.equal(both.filter((o) => /the most it may/.test(o.error ?? '')).length, 1)
    assert.equal(
      await prisma.session.count({ where: { rootId: root.id, origin: 'child' } }),
      SUBTHREADS_AT_WORK,
    )
  })

  test('a sub-thread runs where it is asked, on that computer’s account', async () => {
    const root = await top()
    const cloud = await start(root, { computer: 'cloud' })
    assert.ok(cloud.threadId, JSON.stringify(cloud))
    assert.equal((await row(cloud.threadId)).computerId, computers.cloud)
    const account = await prisma.account.findFirstOrThrow({
      where: { computerId: computers.cloud },
    })
    assert.equal((await row(cloud.threadId)).accountId, account.id)
    // Its brief says where it runs; its first turn goes to that computer.
    const first = await prisma.runnerCommand.findFirst({ where: { sessionId: cloud.threadId } })
    assert.equal(first?.computerId, computers.cloud)
    assert.match(JSON.stringify(first?.message), /You run on Cloud/)
    // Ada has several machines: by name.
    assert.match((await start(root, { computer: 'mine' })).error ?? '', /several machines/)
    const mine = await start(root, { computer: { mine: "ada's laptop" } })
    assert.ok(mine.threadId, JSON.stringify(mine))
    assert.equal((await row(mine.threadId)).computerId, computers.laptop)
    // Never Bob's machine, even by its name: it is not hers.
    assert.match(
      (await start(root, { computer: { mine: "Bob's Mac" } })).error ?? '',
      /None of their machines is called that/,
    )
    assert.equal(await prisma.session.count({ where: { computerId: computers.bobs } }), 0)
  })

  test('refused at once, with why: no account, too old, offline', async () => {
    const root = await top(computers.cloud)
    assert.match(
      (await start(root, { computer: { mine: "Ada's Studio" } })).error ?? '',
      /No Claude.*account is signed in on Ada's Studio/,
    )
    assert.match(
      (await start(root, { computer: { mine: "Ada's Old Mac" } })).error ?? '',
      /too old/,
    )
    const studio = runners[1]!
    studio.close()
    try {
      assert.match(
        (await start(root, { computer: { mine: "Ada's Studio" } })).error ?? '',
        /offline/,
      )
    } finally {
      runners[1] = await fakeRunner(scope, computers.studio)
    }
    // Nothing started anywhere else instead.
    assert.equal(await prisma.session.count({ where: { parentId: root.id } }), 0)
  })

  test('files and branches travel with the brief', async () => {
    const root = await top()
    const { storeAttachment } = await import('../src/attachments.js')
    // As the parent's runner sends it first (POST /runner/attachments).
    const file = await storeAttachment(db, scope, {
      source: 'teammate',
      sessionId: root.id,
      name: 'brief.md',
      bytes: new TextEncoder().encode('# The brief'),
    })
    const out = await start(root, {
      repos: [{ repository: 'gmpetrov/brigade', branch: 'brigade/riley-swarm' }],
      files: [file.id],
    })
    assert.ok(out.threadId, JSON.stringify(out))
    const queued = await prisma.runnerCommand.findMany({ where: { sessionId: out.threadId } })
    const text = JSON.stringify(queued.map((q) => q.message))
    assert.match(text, /Start from `brigade\/riley-swarm` of gmpetrov\/brigade/)
    // Its files come with its first message, in its working folder.
    assert.match(text, /"attachments":\[\{[^\]]*"path":"attachments\/brief\.md"/)
    assert.equal(
      await prisma.threadAttachment.count({
        where: { sessionId: out.threadId, attachmentId: file.id },
      }),
      1,
    )
    // A file of another thread is refused.
    const other = await top()
    const stray = await start(other, { files: ['not-a-file'] })
    assert.match(stray.error ?? '', /not found here/)
  })

  test('needs_parent wakes the parent at once, whatever it waits for', async () => {
    const root = await top()
    const asking = await start(root)
    const slow = await start(root)
    await reports({ id: asking.threadId }, 'needs_parent', 'Ship in English or French first?')
    const [note, ...more] = await notes(root)
    assert.equal(more.length, 0)
    assert.match(note!, /needs its parent/)
    assert.match(note!, /English or French/)
    assert.match(note!, /answer it with `message_thread`/)
    // The slow one still comes alone once it is in, as the batch of what the parent waits for.
    await reports({ id: slow.threadId })
    assert.equal((await notes(root)).length, 2)
    // Answered: it works again, and the parent waits for it again.
    const answer = (await messageThread(db, scope, await row(root.id), riley, {
      threadId: asking.threadId,
      text: 'English first.',
    })) as Record<string, any>
    assert.equal(answer.error, undefined, JSON.stringify(answer))
    const again = await row(asking.threadId)
    assert.equal(again.report, null)
    assert.equal(again.awaited, true)
  })

  test('wake each: every report wakes the parent, as it comes', async () => {
    const root = await top()
    const each = await start(root, { wake: 'each' })
    const batch = await start(root)
    assert.equal((await row(each.threadId)).awaited, false)
    assert.equal((await row(each.threadId)).wakeEach, true)
    await reports({ id: each.threadId }, 'nothing', 'Nothing new yet.')
    assert.equal((await notes(root)).length, 1)
    // The one it waits for with others is unchanged: alone, it is the whole batch.
    await reports({ id: batch.threadId })
    assert.equal((await notes(root)).length, 2)
    // A message to it keeps it one that wakes on each report.
    await messageThread(db, scope, await row(root.id), riley, {
      threadId: each.threadId,
      text: 'Go on.',
    })
    assert.equal((await row(each.threadId)).awaited, false)
  })

  test('message_thread within a tree says the relation; another tree is refused', async () => {
    const root = await top()
    const a = await start(root)
    const b = await start(root)
    const deep = await start({ id: a.threadId })
    const sent = async (from: string, to: string) => {
      const before = await prisma.runnerCommand.count({ where: { sessionId: to } })
      const out = (await messageThread(db, scope, await row(from), riley, {
        threadId: to,
        text: 'Use the violet logo.',
      })) as Record<string, any>
      const commands = await prisma.runnerCommand.findMany({
        where: { sessionId: to },
        orderBy: { createdAt: 'asc' },
      })
      const last = JSON.stringify(commands.slice(before).map((c) => c.message))
      const head = /\*\*Riley\*\* wrote from the (\w+) thread/.exec(last)?.[1] ?? null
      return { out, head }
    }
    const sibling = await sent(a.threadId, b.threadId)
    assert.equal(sibling.out.error, undefined, JSON.stringify(sibling.out))
    assert.equal(sibling.head, 'sibling')
    const up = await sent(deep.threadId, a.threadId)
    assert.equal(up.out.error, undefined, JSON.stringify(up.out))
    assert.equal(up.head, 'child')
    const across = await sent(b.threadId, deep.threadId)
    assert.equal(across.out.error, undefined, JSON.stringify(across.out))
    assert.equal(across.head, 'tree')
    // Read back as the dashboard shows it.
    assert.equal(
      fromParent('**Riley** wrote from the sibling thread “Part”:\n\nHi')?.relation,
      'sibling',
    )
    // Another tree's sub-thread: no.
    const elsewhere = await start(await top())
    assert.match(
      (await sent(a.threadId, elsewhere.threadId)).out.error ?? '',
      /sub-thread|not a thread/,
    )
  })

  test('the spec says where a thread sits in its tree', async () => {
    const root = await top()
    const one = await start(root)
    const two = await start({ id: one.threadId })
    for (const [id, level] of [
      [root.id, 0],
      [one.threadId, 1],
      [two.threadId, 2],
    ] as const) {
      const spec = await specFor(db, await loadThread(db, id))
      assert.deepEqual(spec.tree, { level, rootId: root.id })
    }
  })

  test('the Tree section shows each level, its state, computer and tokens', async () => {
    const root = await top()
    const one = await start(root, { computer: 'cloud' })
    const two = await start({ id: one.threadId })
    await reports({ id: two.threadId }, 'needs_parent', 'Which logo?')
    const token = (sessionId: string, seq: number, n: number) =>
      prisma.tokenUsage.create({
        data: {
          ...scope,
          sessionId,
          seq,
          provider: 'claude_code',
          source: 'child',
          inputTokens: n,
          outputTokens: n,
          at: new Date(),
        },
      })
    await token(root.id, 1, 100)
    await token(one.threadId, 1, 1_000)
    await token(two.threadId, 1, 10_000)
    const tree = await threadTree(db, scope.workspaceId, await row(root.id))
    assert.equal(tree.level, 0)
    assert.equal(tree.rootId, root.id)
    assert.deepEqual(
      tree.nodes.map((n) => [n.id, n.level]),
      [
        [one.threadId, 1],
        [two.threadId, 2],
      ],
    )
    assert.equal(tree.nodes[0]!.computer.id, computers.cloud)
    assert.equal(tree.nodes[1]!.state, 'needs_parent')
    assert.equal(tree.nodes[1]!.tokens, 20_000)
    assert.deepEqual(tree.tokens, { thread: 200, below: 22_000, tree: 22_200 })
    // From the sub-thread, the tree's total is still the whole tree's.
    const below = await threadTree(db, scope.workspaceId, await row(one.threadId))
    assert.equal(below.level, 1)
    assert.equal(below.nodes.length, 1)
    assert.equal(below.tokens.tree, 22_200)
  })

  // Review of #1003.

  test('another member asking in a shared thread cannot send work to the starter’s machine', async () => {
    const root = await top(computers.cloud)
    await prisma.session.update({
      where: { id: root.id },
      data: { askedByMemberId: member('bob'), othersMayPrompt: true },
    })
    const out = await start(root, { computer: { mine: "Ada's Laptop" } })
    assert.match(out.error ?? '', /Only the person whose machine it is/)
    // An outside event's thread (nobody asked) neither.
    await prisma.session.update({ where: { id: root.id }, data: { askedByMemberId: null } })
    assert.match(
      (await start(root, { computer: { mine: "Ada's Laptop" } })).error ?? '',
      /Only the person whose machine it is/,
    )
    // The cloud computer is the workspace's: fine.
    assert.ok((await start(root, { computer: 'cloud' })).threadId)
    assert.equal(
      await prisma.session.count({ where: { parentId: root.id, computerId: computers.laptop } }),
      0,
    )
  })

  test('a sub-thread whose own sub-threads work does not report up yet', async () => {
    const root = await top()
    const one = await start(root)
    const two = await start({ id: one.threadId })
    // Its turn ends while the one it waits for works: nothing goes to the top.
    await prisma.session.update({ where: { id: one.threadId }, data: { status: 'idle' } })
    await noteChildEvents(await row(one.threadId), [
      { event: { type: 'turn.completed', at: new Date().toISOString() } },
    ])
    assert.equal((await row(one.threadId)).report, null)
    assert.equal((await notes(root)).length, 0)
    // Nor by calling report; a question for its parent still goes.
    const early = (await handleChildCall(db, scope, await row(one.threadId), riley, {
      name: 'report',
      status: 'report',
      summary: 'Done.',
    } as never)) as Record<string, any>
    assert.match(early.error ?? '', /still at work: do not report yet/)
    const asking = (await handleChildCall(db, scope, await row(one.threadId), riley, {
      name: 'report',
      status: 'needs_parent',
      summary: 'Which logo?',
    } as never)) as Record<string, any>
    assert.equal(asking.error, undefined, JSON.stringify(asking))
    // Its sub-thread reports: the note is still to reach it, so it still holds.
    await prisma.session.update({ where: { id: one.threadId }, data: { report: Prisma.DbNull } })
    await reports({ id: two.threadId })
    assert.equal((await notes({ id: one.threadId })).length, 1)
    await noteChildEvents(await row(one.threadId), [
      { event: { type: 'turn.completed', at: new Date().toISOString() } },
    ])
    assert.equal((await notes(root)).length, 0)
  })

  test('follow_thread needs its people to be allowed in that thread, then and on delivery', async () => {
    // Ada's own thread on her laptop, closed to others; Bob's thread, Riley in both.
    const hers = await top(computers.laptop)
    const his = await prisma.session.create({
      data: {
        ...scope,
        teammateId: riley.id,
        startedByMemberId: member('bob'),
        askedByMemberId: member('bob'),
        computerId: computers.cloud,
        title: 'Bob’s plan',
        status: 'idle',
      },
    })
    await prisma.threadTeammate.create({
      data: { ...scope, sessionId: his.id, teammateId: riley.id },
    })
    const out = (await handleChildCall(db, scope, his, riley, {
      name: 'follow_thread',
      threadId: hers.id,
    } as never)) as Record<string, any>
    assert.match(out.error ?? '', /only a thread you may write in/)
    assert.equal(await prisma.threadFollow.count({ where: { followerId: his.id } }), 0)
  })

  // Review of #1003, second look.

  test('a message to a sub-thread on the starter’s Mac needs the starter’s word each time', async () => {
    const root = await top(computers.cloud)
    const onMac = await start(root, { computer: { mine: "Ada's Laptop" } })
    assert.ok(onMac.threadId, JSON.stringify(onMac))
    await reports({ id: onMac.threadId })
    // The thread is shared since, and Bob asks in it.
    await prisma.session.update({
      where: { id: root.id },
      data: { askedByMemberId: member('bob'), othersMayPrompt: true },
    })
    const out = (await messageThread(db, scope, await row(root.id), riley, {
      threadId: onMac.threadId,
      text: 'Open Keynote again.',
    })) as Record<string, any>
    assert.match(out.error ?? '', /person's own machine/)
    // Its report stays, and nothing was sent to the Mac.
    assert.notEqual((await row(onMac.threadId)).report, null)
  })

  test('a message that does not go leaves the report and the place as they were', async () => {
    const root = await top()
    const a = await start(root)
    const b = await start(root)
    await reports({ id: b.threadId }, 'report', 'Posts drafted.')
    const before = await row(b.threadId)
    // A person has control of it: refused before anything changes.
    await prisma.session.update({
      where: { id: b.threadId },
      data: { controlledByMemberId: member('ada') },
    })
    const taken = (await messageThread(db, scope, await row(a.threadId), riley, {
      threadId: b.threadId,
      text: 'Shorter, please.',
    })) as Record<string, any>
    assert.match(taken.error ?? '', /has control/)
    assert.equal((await row(b.threadId)).report && 'kept', 'kept')
    await prisma.session.update({ where: { id: b.threadId }, data: { controlledByMemberId: null } })
    // Its computer offline: the report comes back.
    const laptop = runners[0]!
    laptop.close()
    try {
      const offline = (await messageThread(db, scope, await row(a.threadId), riley, {
        threadId: b.threadId,
        text: 'Shorter, please.',
      })) as Record<string, any>
      assert.match(offline.error ?? '', /offline/)
    } finally {
      runners[0] = await fakeRunner(scope, computers.laptop)
    }
    const after = await row(b.threadId)
    assert.equal((after.report as { summary?: string } | null)?.summary, 'Posts drafted.')
    assert.deepEqual(after.reportDeliveredAt, before.reportDeliveredAt)
    assert.equal(after.status, before.status)
  })

  test('read_child on a followed thread stops once its people may no longer read it', async () => {
    // On her own laptop, opened to others (a thread on the cloud computer always is).
    const hers = await top(computers.laptop)
    await prisma.session.update({ where: { id: hers.id }, data: { othersMayPrompt: true } })
    const his = await prisma.session.create({
      data: {
        ...scope,
        teammateId: riley.id,
        startedByMemberId: member('bob'),
        askedByMemberId: member('bob'),
        computerId: computers.cloud,
        title: 'Bob’s plan',
        status: 'idle',
      },
    })
    await prisma.threadTeammate.create({
      data: { ...scope, sessionId: his.id, teammateId: riley.id },
    })
    const follow = (await handleChildCall(db, scope, his, riley, {
      name: 'follow_thread',
      threadId: hers.id,
    } as never)) as Record<string, any>
    assert.equal(follow.error, undefined, JSON.stringify(follow))
    const read = () =>
      handleChildCall(db, scope, his, riley, {
        name: 'read_child',
        threadId: hers.id,
      } as never) as Promise<Record<string, any>>
    assert.equal((await read()).error, undefined)
    // Closed to others since.
    await prisma.session.update({ where: { id: hers.id }, data: { othersMayPrompt: false } })
    assert.match((await read()).error ?? '', /may no longer read that one/)
  })

  test('a finished sub-thread goes on when told more, even with the tree full: the cap is on new ones', async () => {
    const root = await top()
    const done = await start(root)
    await reports({ id: done.threadId })
    for (let i = 0; i < SUBTHREADS_AT_WORK; i++) assert.ok((await start(root)).threadId)
    assert.match((await start(root)).error ?? '', /the most it may/)
    const again = (await messageThread(db, scope, await row(root.id), riley, {
      threadId: done.threadId,
      text: 'One more thing.',
    })) as Record<string, any>
    assert.equal(again.error, undefined, JSON.stringify(again))
    assert.equal((await row(done.threadId)).report, null)
  })

  test('a follow-up to a sub-thread on an offline Mac keeps its report', async () => {
    const root = await top(computers.cloud)
    const onMac = await start(root, { computer: { mine: "Ada's Laptop" } })
    assert.ok(onMac.threadId, JSON.stringify(onMac))
    await reports({ id: onMac.threadId }, 'report', 'Deck drafted in Keynote.')
    const kept = await row(onMac.threadId)
    const laptop = runners[0]!
    laptop.close()
    try {
      const out = (await messageThread(db, scope, await row(root.id), riley, {
        threadId: onMac.threadId,
        text: 'Add a slide on pricing.',
      })) as Record<string, any>
      assert.match(out.error ?? '', /offline/)
    } finally {
      runners[0] = await fakeRunner(scope, computers.laptop)
    }
    const after = await row(onMac.threadId)
    assert.equal((after.report as { summary?: string } | null)?.summary, 'Deck drafted in Keynote.')
    assert.deepEqual(after.reportDeliveredAt, kept.reportDeliveredAt)
    assert.equal(after.awaited, kept.awaited)
  })
})
