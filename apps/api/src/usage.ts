// What the workspace's Claude and Codex subscriptions spend tokens on (Settings › Usage): each
// teammate turn's usage.updated events and each run outside a turn (usage.run), kept as
// TokenUsage rows with who and what they were for. Counts only, never what was said.
import type {
  RunnerToApi,
  SequencedEvent,
  TokenCounts,
  UsageGroup,
  UsagePeriod,
  UsageResponse,
  UsageSource,
  UsageTotals,
} from '@brigade/contracts'
import { Prisma, prisma, scoped, type Scope } from './db.js'

/** Postgres' integer: a count past it is a harness's mistake, not tokens spent. */
const INT_MAX = 2_147_483_647
const tokens = (n: number | undefined) =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), INT_MAX) : 0

/** A run's counts as a row's columns. */
export function tokenColumns(counts: TokenCounts) {
  return {
    inputTokens: tokens(counts.inputTokens),
    cacheReadTokens: tokens(counts.cacheReadTokens),
    cacheWriteTokens: tokens(counts.cacheWriteTokens),
    outputTokens: tokens(counts.outputTokens),
    reasoningTokens: tokens(counts.reasoningTokens),
    model: counts.model?.slice(0, 200) || null,
  }
}

/** Whether a usage event counts tokens: one that only reads limits (Claude's) spends none. */
export const spends = (event: SequencedEvent['event']) =>
  event.type === 'usage.updated' &&
  (event.inputTokens !== undefined || event.outputTokens !== undefined)

/** What started a thread, as Usage sorts it: work no person asked for apart from the rest. */
export function threadSource(session: {
  origin: string
  playbookRunId: string | null
  reviews: number
}): UsageSource {
  if (session.playbookRunId) return 'playbook'
  if (session.reviews > 0) return 'review'
  return session.origin as UsageSource
}

type ThreadForUsage = {
  id: string
  organizationId: string
  workspaceId: string
  teammateId: string
  accountId: string | null
}

/**
 * Keep the tokens a run of a thread's events spent, once each (by the event's seq): a run
 * noted again counts nothing twice. Each turn says its account (turn.started); the runner
 * also stamps it on the usage event itself.
 */
export async function noteTokenUsage(session: ThreadForUsage, events: SequencedEvent[]) {
  if (!events.some((e) => spends(e.event))) return
  const db = scoped(session)
  const thread = await db.session.findFirstOrThrow({
    where: { id: session.id },
    select: {
      origin: true,
      playbookRunId: true,
      projectId: true,
      scheduleId: true,
      _count: { select: { reviewsOf: true } },
    },
  })
  const source = threadSource({ ...thread, reviews: thread._count.reviewsOf })
  let accountId = session.accountId
  let teammateId = session.teammateId
  const spent: {
    seq: number
    at: string
    accountId: string | null
    teammateId: string
    counts: TokenCounts
  }[] = []
  for (const { seq, event } of events) {
    if (event.type === 'turn.started') {
      accountId = event.accountId
      teammateId = event.teammateId
    }
    if (event.type === 'account.switched' && event.toAccountId) accountId = event.toAccountId
    if (event.type !== 'usage.updated' || !spends(event)) continue
    spent.push({
      seq,
      at: event.at,
      accountId: event.accountId ?? accountId,
      teammateId: event.teammateId ?? teammateId,
      counts: event,
    })
  }
  const owners = await accountOwners(
    db,
    spent.map((s) => s.accountId),
    spent.map((s) => s.teammateId),
  )
  await db.tokenUsage.createMany({
    data: spent.map((s) => ({
      organizationId: session.organizationId,
      workspaceId: session.workspaceId,
      sessionId: session.id,
      seq: s.seq,
      teammateId: s.teammateId,
      accountId: s.accountId,
      memberId: (s.accountId && owners.accounts.get(s.accountId)?.memberId) || null,
      projectId: thread.projectId,
      scheduleId: thread.scheduleId,
      provider:
        (s.accountId && owners.accounts.get(s.accountId)?.provider) ||
        owners.teammates.get(s.teammateId) ||
        'claude_code',
      source,
      at: new Date(s.at),
      ...tokenColumns(s.counts),
    })),
    skipDuplicates: true,
  })
}

/** The accounts' owners and providers, and the teammates' harnesses for an account since removed. */
async function accountOwners(
  db: ReturnType<typeof scoped>,
  accountIds: (string | null)[],
  teammateIds: string[],
) {
  const ids = [...new Set(accountIds.filter((id): id is string => !!id))]
  const [accounts, teammates] = await Promise.all([
    ids.length
      ? db.account.findMany({
          where: { id: { in: ids } },
          select: { id: true, memberId: true, provider: true },
        })
      : [],
    db.teammate.findMany({
      where: { id: { in: [...new Set(teammateIds)] } },
      select: { id: true, harness: true },
    }),
  ])
  return {
    accounts: new Map(accounts.map((a) => [a.id, a])),
    teammates: new Map(teammates.map((t) => [t.id, t.harness])),
  }
}

/**
 * A run outside a teammate's turn (usage.run): on an account of the runner's own computer,
 * for a thread of its workspace when it names one.
 */
export async function noteUsageRun(
  runner: { computerId: string; organizationId: string; workspaceId: string },
  message: Extract<RunnerToApi, { type: 'usage.run' }>,
) {
  const db = scoped({ organizationId: runner.organizationId, workspaceId: runner.workspaceId })
  const account = await db.account.findFirst({
    where: { id: message.accountId, computerId: runner.computerId },
    select: { id: true, memberId: true, provider: true },
  })
  if (!account) return
  const thread = message.sessionId
    ? await db.session.findFirst({
        where: { id: message.sessionId },
        select: { id: true, projectId: true, scheduleId: true },
      })
    : null
  const teammate = message.teammateId
    ? await db.teammate.findFirst({ where: { id: message.teammateId }, select: { id: true } })
    : null
  const at = new Date(message.at)
  await db.tokenUsage.create({
    data: {
      organizationId: runner.organizationId,
      workspaceId: runner.workspaceId,
      sessionId: thread?.id ?? null,
      teammateId: teammate?.id ?? null,
      accountId: account.id,
      memberId: account.memberId,
      projectId: thread?.projectId ?? null,
      scheduleId: thread?.scheduleId ?? null,
      provider: account.provider,
      source: message.kind,
      // A clock far off is the runner's: the row goes in when it came.
      at:
        Number.isNaN(at.getTime()) || Math.abs(at.getTime() - Date.now()) > DAY_MS
          ? new Date()
          : at,
      ...tokenColumns(message),
    },
  })
}

const DAY_MS = 24 * 60 * 60_000

type Row = {
  id: string | null
  input: bigint | number | null
  cache_read: bigint | number | null
  cache_write: bigint | number | null
  output: bigint | number | null
  runs: bigint | number | null
}

const totals = (row: Row | undefined): UsageTotals => ({
  input: Number(row?.input ?? 0),
  cacheRead: Number(row?.cache_read ?? 0),
  cacheWrite: Number(row?.cache_write ?? 0),
  output: Number(row?.output ?? 0),
  runs: Number(row?.runs ?? 0),
})

/** The columns Usage groups by: never from the request, so never anything else. */
const GROUP_COLUMNS = {
  provider: Prisma.sql`"provider"::text`,
  source: Prisma.sql`"source"`,
  teammate: Prisma.sql`"teammateId"`,
  model: Prisma.sql`"model"`,
  member: Prisma.sql`"memberId"`,
  thread: Prisma.sql`"sessionId"`,
  schedule: Prisma.sql`"scheduleId"`,
  // Stored in UTC, with no zone: its day is UTC's.
  day: Prisma.sql`to_char(date_trunc('day', "at"), 'YYYY-MM-DD')`,
} as const

/**
 * What the workspace spent over the last `days`: in all for owners and admins, else only what
 * the asking member's own accounts spent (an account is its member's alone).
 */
export async function usageReport(
  scope: Scope & { memberId: string; role: string },
  days: UsagePeriod,
  now = new Date(),
): Promise<UsageResponse> {
  const all = scope.role === 'owner' || scope.role === 'admin'
  const since = new Date(now.getTime() - days * DAY_MS)
  const where = Prisma.sql`"workspaceId" = ${scope.workspaceId} AND "at" >= ${since}${
    all ? Prisma.empty : Prisma.sql` AND "memberId" = ${scope.memberId}`
  }`
  const sums = Prisma.sql`sum("inputTokens")::bigint AS input, sum("cacheReadTokens")::bigint AS cache_read,
    sum("cacheWriteTokens")::bigint AS cache_write, sum("outputTokens")::bigint AS output`
  const grouped = (
    by: keyof typeof GROUP_COLUMNS,
    options: { limit?: number; runs?: 'rows' | 'threads'; notNull?: boolean } = {},
  ) => {
    const column = GROUP_COLUMNS[by]
    const runs =
      options.runs === 'threads' ? Prisma.sql`count(DISTINCT "sessionId")` : Prisma.sql`count(*)`
    return prisma.$queryRaw<Row[]>`
      SELECT ${column} AS id, ${sums}, ${runs}::bigint AS runs
      FROM "TokenUsage"
      WHERE ${where}${options.notNull ? Prisma.sql` AND ${column} IS NOT NULL` : Prisma.empty}
      GROUP BY 1
      ORDER BY sum("inputTokens") + sum("outputTokens") DESC
      ${options.limit ? Prisma.sql`LIMIT ${options.limit}` : Prisma.empty}`
  }
  const [total, daily, byProvider, bySource, byTeammate, byModel, byMember, threads, schedules] =
    await Promise.all([
      prisma.$queryRaw<
        Row[]
      >`SELECT NULL AS id, ${sums}, count(*)::bigint AS runs FROM "TokenUsage" WHERE ${where}`,
      grouped('day'),
      grouped('provider'),
      grouped('source'),
      grouped('teammate', { limit: 20 }),
      grouped('model', { limit: 10 }),
      all ? grouped('member', { limit: 20 }) : Promise.resolve([]),
      grouped('thread', { limit: 15, notNull: true }),
      grouped('schedule', { limit: 10, runs: 'threads', notNull: true }),
    ])
  const names = await usageNames(scope, {
    teammates: [...byTeammate, ...threads].map((r) => r.id),
    members: byMember.map((r) => r.id),
    threads: threads.map((r) => r.id),
    schedules: schedules.map((r) => r.id),
  })
  const group = (rows: Row[], label: (id: string | null) => string): UsageGroup[] =>
    rows.map((r) => ({ id: r.id ?? '', label: label(r.id), ...totals(r) }))
  return {
    days,
    scope: all ? 'all' : 'mine',
    since: since.toISOString(),
    totals: totals(total[0]),
    daily: everyDay(since, now, daily),
    byProvider: group(byProvider, (id) => (id === 'codex' ? 'Codex' : 'Claude')),
    bySource: group(bySource, (id) => id ?? ''),
    byTeammate: group(byTeammate, (id) => (id && names.teammates.get(id)) || 'Brigade'),
    byModel: group(byModel, (id) => id || 'Not reported'),
    byMember: group(byMember, (id) => (id && names.members.get(id)) || 'Removed member'),
    topThreads: threads.map((r) => {
      const thread = r.id ? names.threads.get(r.id) : undefined
      return {
        id: r.id ?? '',
        label: thread?.title ?? 'Deleted thread',
        source: thread?.source ?? 'member',
        teammateId: thread?.teammateId ?? null,
        ...totals(r),
      }
    }),
    topSchedules: group(schedules, (id) => (id && names.schedules.get(id)) || 'Deleted routine'),
  }
}

/** Each day of the stretch, with nothing for a day that spent nothing. */
function everyDay(since: Date, now: Date, rows: Row[]) {
  const byDay = new Map(rows.map((r) => [r.id, r]))
  const days: UsageResponse['daily'] = []
  const day = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate()))
  while (day <= now) {
    const key = day.toISOString().slice(0, 10)
    days.push({ day: key, ...totals(byDay.get(key)) })
    day.setUTCDate(day.getUTCDate() + 1)
  }
  return days
}

/** What the groups' ids are called, within the workspace. */
async function usageNames(
  scope: Scope,
  ids: {
    teammates: (string | null)[]
    members: (string | null)[]
    threads: (string | null)[]
    schedules: (string | null)[]
  },
) {
  const db = scoped(scope)
  const only = (list: (string | null)[]) => [...new Set(list.filter((id): id is string => !!id))]
  const [teammates, members, threads, schedules] = await Promise.all([
    db.teammate.findMany({
      where: { id: { in: only(ids.teammates) } },
      select: { id: true, name: true },
    }),
    db.member.findMany({
      where: { id: { in: only(ids.members) } },
      select: { id: true, user: { select: { name: true, email: true } } },
    }),
    db.session.findMany({
      where: { id: { in: only(ids.threads) } },
      select: {
        id: true,
        title: true,
        teammateId: true,
        origin: true,
        playbookRunId: true,
        _count: { select: { reviewsOf: true } },
      },
    }),
    db.schedule.findMany({
      where: { id: { in: only(ids.schedules) } },
      select: { id: true, title: true },
    }),
  ])
  return {
    teammates: new Map(teammates.map((t) => [t.id, t.name])),
    members: new Map(members.map((m) => [m.id, m.user.name || m.user.email])),
    threads: new Map(
      threads.map((t) => [
        t.id,
        {
          title: t.title,
          teammateId: t.teammateId,
          source: threadSource({ ...t, reviews: t._count.reviewsOf }),
        },
      ]),
    ),
    schedules: new Map(schedules.map((s) => [s.id, s.title])),
  }
}
