import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import pg from 'pg'
import type { SequencedEvent } from '@brigade/contracts'

// Usage (src/usage.ts) against a real database: the local one of apps/api/.env, in an
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
    await client.query('select 1 from "TokenUsage" limit 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}
const skip = (await reachable()) ? false : 'no database to reach (apps/api/.env DATABASE_URL)'

const { prisma } = await import('../src/db.js')
const { noteLoggedResponses, noteTokenUsage, noteUsageRun, usageReport } =
  await import('../src/usage.js')

const id = randomUUID().slice(0, 8)
const ids = {
  organization: `org-usage-${id}`,
  users: [`user-usage-${id}`, `user-usage-b-${id}`],
  members: [`mem-usage-${id}`, `mem-usage-b-${id}`],
}
let scope: { organizationId: string; workspaceId: string }
let riley: string
let sam: string
let computerId: string
let otherComputerId: string
let ada: string
let bobCodex: string

before(async () => {
  if (skip) return
  await prisma.organization.create({
    data: { id: ids.organization, name: 'Usage test', slug: ids.organization },
  })
  for (const [i, userId] of ids.users.entries()) {
    await prisma.user.create({
      data: { id: userId, name: ['Ada', 'Bob'][i]!, email: `${userId}@example.com` },
    })
    await prisma.member.create({
      data: {
        id: ids.members[i]!,
        organizationId: ids.organization,
        userId,
        role: i === 0 ? 'owner' : 'member',
      },
    })
  }
  const workspace = await prisma.workspace.create({
    data: { organizationId: ids.organization, name: 'Usage test' },
  })
  scope = { organizationId: ids.organization, workspaceId: workspace.id }
  riley = (await prisma.teammate.create({ data: { ...scope, name: 'Riley' } })).id
  sam = (await prisma.teammate.create({ data: { ...scope, name: 'Sam', harness: 'codex' } })).id
  computerId = (await prisma.computer.create({ data: { ...scope, kind: 'cloud', name: 'Cloud' } }))
    .id
  otherComputerId = (
    await prisma.computer.create({ data: { ...scope, kind: 'cloud', name: 'Other' } })
  ).id
  const account = (memberId: string, provider: 'claude_code' | 'codex') =>
    prisma.account.create({
      data: { ...scope, memberId, computerId, provider, label: provider },
    })
  ada = (await account(ids.members[0]!, 'claude_code')).id
  bobCodex = (await account(ids.members[1]!, 'codex')).id
})

after(async () => {
  if (skip) return
  await prisma.organization.deleteMany({ where: { id: ids.organization } })
  await prisma.user.deleteMany({ where: { id: { in: ids.users } } })
  await prisma.$disconnect()
})

const thread = (data: Record<string, unknown> = {}) =>
  prisma.session.create({
    data: {
      ...scope,
      teammateId: riley,
      startedByMemberId: ids.members[0]!,
      computerId,
      accountId: ada,
      title: 'Fix the login',
      status: 'idle',
      ...data,
    },
  })

const now = new Date()
const at = (minutesAgo = 0) => new Date(now.getTime() - minutesAgo * 60_000).toISOString()
let seq = 0
const event = (e: Record<string, unknown>): SequencedEvent =>
  ({ sessionId: '', seq: ++seq, event: { at: at(), ...e } }) as unknown as SequencedEvent

const owner = () => ({ ...scope, memberId: ids.members[0]!, role: 'owner' })
const member = () => ({ ...scope, memberId: ids.members[1]!, role: 'member' })

test(
  "each turn's tokens are kept once, on the account and teammate that spent them",
  { skip },
  async () => {
    const t = await thread()
    const events = [
      event({ type: 'turn.started', teammateId: riley, accountId: ada }),
      event({ type: 'usage.updated', status: 'allowed', limits: [] }),
      event({
        type: 'usage.updated',
        teammateId: riley,
        inputTokens: 120_000,
        cacheReadTokens: 110_000,
        cacheWriteTokens: 8_000,
        outputTokens: 3_000,
        reasoningTokens: 500,
        model: 'claude-opus-5-5',
      }),
      event({ type: 'turn.started', teammateId: sam, accountId: bobCodex }),
      event({ type: 'usage.updated', teammateId: sam, inputTokens: 40_000, outputTokens: 1_000 }),
    ]
    const session = { ...t, accountId: ada }
    await noteTokenUsage(session, events)
    // Noted again (an event resent, a retry): nothing counts twice.
    await noteTokenUsage(session, events)
    const rows = await prisma.tokenUsage.findMany({
      where: { sessionId: t.id },
      orderBy: { seq: 'asc' },
    })
    assert.equal(rows.length, 2)
    assert.deepEqual(
      rows.map((r) => [r.teammateId, r.accountId, r.memberId, r.provider, r.source, r.model]),
      [
        [riley, ada, ids.members[0], 'claude_code', 'member', 'claude-opus-5-5'],
        [sam, bobCodex, ids.members[1], 'codex', 'member', null],
      ],
    )
    assert.equal(rows[0]!.cacheReadTokens, 110_000)
    assert.equal(rows[0]!.reasoningTokens, 500)
  },
)

test(
  'after an account runs out mid-turn, what follows is the next account’s',
  { skip },
  async () => {
    const next = await prisma.account.create({
      data: {
        ...scope,
        memberId: ids.members[0]!,
        computerId,
        provider: 'claude_code',
        label: 'Second Claude',
      },
    })
    const t = await thread()
    await noteTokenUsage({ ...t, accountId: ada }, [
      event({ type: 'turn.started', teammateId: riley, accountId: ada }),
      event({ type: 'usage.updated', teammateId: riley, inputTokens: 10, outputTokens: 1 }),
      event({
        type: 'account.switched',
        fromAccountId: ada,
        toAccountId: next.id,
        reason: 'usage_limit',
        resetsAt: null,
      }),
      // An older runner stamps no account: the switch says whose it is.
      event({ type: 'usage.updated', teammateId: riley, inputTokens: 20, outputTokens: 2 }),
      // The runner's stamp is the stream's own account.
      event({
        type: 'usage.updated',
        teammateId: riley,
        accountId: next.id,
        inputTokens: 30,
        outputTokens: 3,
      }),
    ])
    const rows = await prisma.tokenUsage.findMany({
      where: { sessionId: t.id },
      orderBy: { seq: 'asc' },
    })
    assert.deepEqual(
      rows.map((r) => [r.inputTokens, r.accountId]),
      [
        [10, ada],
        [20, next.id],
        [30, next.id],
      ],
    )
    // Not in the totals the next tests count.
    await prisma.session.delete({ where: { id: t.id } })
    await prisma.tokenUsage.deleteMany({ where: { accountId: next.id } })
    await prisma.tokenUsage.deleteMany({ where: { sessionId: null, inputTokens: 10 } })
  },
)

test("a routine's runs and Brigade's own runs are told apart", { skip }, async () => {
  const schedule = await prisma.schedule.create({
    data: {
      ...scope,
      teammateId: riley,
      title: 'Morning digest',
      instructions: 'Sum up the night',
      cron: '0 8 * * *',
      timezone: 'UTC',
      ownerMemberId: ids.members[0]!,
    },
  })
  for (const n of [1, 2]) {
    const run = await thread({ origin: 'schedule', scheduleId: schedule.id, title: `Digest ${n}` })
    await noteTokenUsage({ ...run, accountId: ada }, [
      event({
        type: 'usage.updated',
        teammateId: riley,
        inputTokens: 500_000,
        outputTokens: 2_000,
      }),
    ])
  }
  const t = await thread()
  const base = { type: 'usage.run' as const, at: at(), inputTokens: 9_000, outputTokens: 300 }
  await noteUsageRun(
    { ...scope, computerId },
    {
      ...base,
      kind: 'memory',
      accountId: ada,
      sessionId: t.id,
      teammateId: riley,
    },
  )
  // An account of another computer is not this runner's to spend.
  await noteUsageRun(
    { ...scope, computerId: otherComputerId },
    {
      ...base,
      kind: 'title',
      accountId: ada,
    },
  )
  const runs = await prisma.tokenUsage.findMany({
    where: { workspaceId: scope.workspaceId, source: { in: ['memory', 'title'] } },
  })
  assert.deepEqual(
    runs.map((r) => [r.source, r.sessionId, r.memberId]),
    [['memory', t.id, ids.members[0]]],
  )

  const report = await usageReport(owner(), 7, now)
  assert.equal(report.scope, 'all')
  const digest = report.topSchedules.find((s) => s.id === schedule.id)
  assert.deepEqual(digest && [digest.label, digest.runs, digest.input], [
    'Morning digest',
    2,
    1_000_000,
  ])
  const source = new Map(report.bySource.map((s) => [s.id, s.input]))
  assert.equal(source.get('schedule'), 1_000_000)
  assert.equal(source.get('memory'), 9_000)
  assert.equal(report.topThreads[0]!.label.startsWith('Digest'), true)
  assert.equal(report.topThreads[0]!.source, 'schedule')
})

test(
  'owners see the whole workspace, a member only their own accounts, day by day',
  { skip },
  async () => {
    const all = await usageReport(owner(), 7, now)
    const mine = await usageReport(member(), 7, now)
    assert.equal(all.totals.input, 120_000 + 40_000 + 1_000_000 + 9_000)
    assert.equal(mine.scope, 'mine')
    assert.equal(mine.totals.input, 40_000)
    assert.deepEqual(mine.byMember, [])
    assert.deepEqual(
      all.byMember.map((m) => [m.label, m.input]),
      [
        ['Ada', 1_129_000],
        ['Bob', 40_000],
      ],
    )
    assert.deepEqual(
      all.byProvider.map((p) => p.label),
      ['Claude', 'Codex'],
    )
    assert.equal(all.daily.length, 8)
    assert.equal(all.daily.at(-1)!.day, now.toISOString().slice(0, 10))
    assert.equal(
      all.daily.reduce((sum, d) => sum + d.input, 0),
      all.totals.input,
    )
    // A thread deleted later keeps its tokens in the totals.
    const t = await thread({ title: 'Gone soon' })
    await noteTokenUsage({ ...t, accountId: ada }, [
      event({ type: 'usage.updated', teammateId: riley, inputTokens: 7, outputTokens: 1 }),
    ])
    await prisma.session.delete({ where: { id: t.id } })
    assert.equal((await usageReport(owner(), 7, now)).totals.input, all.totals.input + 7)
  },
)

test(
  "a turn is counted response by response from its log, and its stream's totals no longer count",
  { skip },
  async () => {
    // A workspace of its own: its report counts only this.
    const workspace = await prisma.workspace.create({
      data: { organizationId: ids.organization, name: 'Logged usage' },
    })
    const w = { organizationId: ids.organization, workspaceId: workspace.id }
    const rey = (await prisma.teammate.create({ data: { ...w, name: 'Rey' } })).id
    const cloud = (await prisma.computer.create({ data: { ...w, kind: 'cloud', name: 'Cloud' } }))
      .id
    const mac = (
      await prisma.computer.create({ data: { ...w, kind: 'member_machine', name: 'Mac' } })
    ).id
    const claude = (
      await prisma.account.create({
        data: {
          ...w,
          memberId: ids.members[0]!,
          computerId: cloud,
          provider: 'claude_code',
          label: 'Claude',
        },
      })
    ).id
    const own = (
      await prisma.account.create({
        data: {
          ...w,
          memberId: ids.members[1]!,
          computerId: mac,
          provider: 'claude_code',
          source: 'machine',
          label: 'Claude on the Mac',
        },
      })
    ).id
    const t = await prisma.session.create({
      data: {
        ...w,
        teammateId: rey,
        startedByMemberId: ids.members[0]!,
        computerId: cloud,
        accountId: claude,
        title: 'Logged',
        status: 'idle',
      },
    })
    const session = { ...t, accountId: claude }
    const turn = (minutesAgo: number, e: Record<string, unknown>) =>
      ({
        sessionId: t.id,
        seq: ++seq,
        event: { at: at(minutesAgo), type: 'usage.updated', teammateId: rey, ...e },
      }) as unknown as SequencedEvent
    const response = (id: string, minutesAgo: number, r: Record<string, unknown> = {}) => ({
      id,
      sessionId: t.id,
      teammateId: rey,
      accountId: claude,
      provider: 'claude_code' as const,
      model: 'claude-opus-5-5',
      at: at(minutesAgo),
      inputTokens: 1_000,
      cacheReadTokens: 900,
      cacheWriteTokens: 50,
      outputTokens: 10,
      reasoningTokens: 0,
      ...r,
    })

    // Before its log begins (an older runner's turn): the stream's totals count.
    await noteTokenUsage(session, [
      turn(120, {
        inputTokens: 5_000,
        outputTokens: 50,
        accountId: claude,
        model: 'claude-opus-5-5',
      }),
    ])
    // A turn noted before its responses came.
    await noteTokenUsage(session, [
      turn(50, {
        inputTokens: 1_500,
        outputTokens: 20,
        accountId: claude,
        model: 'claude-opus-5-5',
      }),
    ])
    const cloudRunner = { ...w, computerId: cloud }
    await noteLoggedResponses(cloudRunner, [
      response('msg_1', 55),
      // A subagent on another model.
      response('msg_2', 52, { model: 'claude-haiku-5-5', inputTokens: 400, outputTokens: 5 }),
      // Read again as its log was written on: its output grew. One row, the most read.
      response('msg_1', 55, { outputTokens: 4 }),
      response('msg_1', 55, { outputTokens: 30 }),
      // Not this runner's or this workspace's to count.
      response('msg_x1', 50, { sessionId: 'no-such-thread' }),
      response('msg_x2', 50, { teammateId: riley }),
      response('msg_x3', 50, { accountId: own }),
    ])
    // A later turn whose responses came first: its stream's totals never count, nor those of a
    // stream that only repeated them (a turn split by background work).
    await noteLoggedResponses(cloudRunner, [response('msg_3', 20, { inputTokens: 2_000 })])
    // Sent again after a lost answer: nothing counts twice.
    await noteLoggedResponses(cloudRunner, [response('msg_3', 20, { inputTokens: 2_000 })])
    await noteTokenUsage(session, [
      turn(15, {
        inputTokens: 2_000,
        outputTokens: 10,
        accountId: claude,
        model: 'claude-opus-5-5',
      }),
      turn(14, { inputTokens: 2_000, outputTokens: 10, accountId: claude }),
    ])
    // A member's machine names no account: its own login is.
    await noteLoggedResponses({ ...w, computerId: mac }, [
      { ...response('msg_4', 10, { inputTokens: 100, outputTokens: 1 }), accountId: undefined },
    ])

    const rows = await prisma.tokenUsage.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { at: 'asc' },
    })
    assert.deepEqual(
      rows.map((r) => [r.responseId, r.inputTokens, r.outputTokens, r.replaced, r.accountId]),
      [
        [null, 5_000, 50, false, claude],
        ['msg_1', 1_000, 30, false, claude],
        ['msg_2', 400, 5, false, claude],
        [null, 1_500, 20, true, claude],
        ['msg_3', 2_000, 10, false, claude],
        [null, 2_000, 10, true, claude],
        [null, 2_000, 10, true, claude],
        ['msg_4', 100, 1, false, own],
      ],
    )
    assert.equal(rows[1]!.memberId, ids.members[0])
    assert.equal(rows[7]!.memberId, ids.members[1])

    const report = await usageReport({ ...w, memberId: ids.members[0]!, role: 'owner' }, 7, now)
    assert.equal(report.totals.input, 5_000 + 1_000 + 400 + 2_000 + 100)
    assert.equal(report.totals.output, 50 + 30 + 5 + 10 + 1)
    // Each turn still counts once; a response is no turn.
    assert.equal(report.totals.runs, 4)
    assert.deepEqual(
      report.byModel.map((m) => [m.label, m.input, m.runs]),
      [
        ['claude-opus-5-5', 5_000 + 1_000 + 2_000 + 100, 3],
        ['claude-haiku-5-5', 400, 0],
      ],
    )
    assert.deepEqual(
      report.topThreads.map((th) => [th.label, th.input, th.runs]),
      [['Logged', 8_500, 4]],
    )
  },
)
