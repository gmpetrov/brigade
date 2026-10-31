// What the workspace's Claude and Codex subscriptions spend tokens on (Settings › Usage), kept as
// TokenUsage rows with who and what they were for. Counts only, never what was said. A teammate's
// turns are counted response by response from the harness's own log on its computer
// (usage.responses); the totals its stream gave (usage.updated) count only for turns no log
// covers: an older runner's, or before a thread's log begins. Runs outside a turn come as usage.run.
import { randomUUID } from 'node:crypto'
import type {
  LoggedResponse,
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
import type { PrismaClient } from './generated/prisma/client.js'

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
 * also stamps it on the usage event itself. A turn its log already counted response by response
 * (noteLoggedResponses) keeps its row, to count the turn, with its tokens replaced.
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
  await prisma.$transaction(async (tx) => {
    await lockUsage(tx, [session.id])
    const logged = await loggedFrom(tx, session)
    await tx.tokenUsage.createMany({
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
        replaced: logged.some(
          (l) =>
            l.teammateId === s.teammateId &&
            l.accountId === s.accountId &&
            l.first.getTime() <= new Date(s.at).getTime(),
        ),
        ...tokenColumns(s.counts),
      })),
      skipDuplicates: true,
    })
  })
}

type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'>

/**
 * One writer of a thread's usage at a time: a turn's row and the responses that replace it may
 * come together, from the thread's events and from its log.
 */
async function lockUsage(tx: Tx, sessionIds: string[]) {
  for (const id of [...new Set(sessionIds)].sort())
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`usage:${id}`}))`
}

/** Since when a thread's turns are counted from their log, by teammate and account. */
function loggedFrom(tx: Tx, session: { id: string; workspaceId: string }) {
  return tx.$queryRaw<{ teammateId: string; accountId: string; first: Date }[]>`
    SELECT "teammateId", "accountId", min("at") AS first FROM "TokenUsage"
    WHERE "workspaceId" = ${session.workspaceId} AND "sessionId" = ${session.id}
      AND "responseId" IS NOT NULL AND "teammateId" IS NOT NULL AND "accountId" IS NOT NULL
    GROUP BY 1, 2`
}

/** One per response: what was read of it most (a response's output grows as its log is written). */
function mergeResponses(responses: LoggedResponse[]) {
  const byId = new Map<string, LoggedResponse>()
  for (const r of responses) {
    const seen = byId.get(r.id)
    byId.set(
      r.id,
      seen
        ? {
            ...seen,
            at: seen.at < r.at ? seen.at : r.at,
            inputTokens: Math.max(seen.inputTokens, r.inputTokens),
            cacheReadTokens: Math.max(seen.cacheReadTokens, r.cacheReadTokens),
            cacheWriteTokens: Math.max(seen.cacheWriteTokens, r.cacheWriteTokens),
            outputTokens: Math.max(seen.outputTokens, r.outputTokens),
            reasoningTokens: Math.max(seen.reasoningTokens, r.reasoningTokens),
            ...(seen.model || !r.model ? {} : { model: r.model }),
          }
        : r,
    )
  }
  return [...byId.values()]
}

/**
 * What a teammate's turns spent, response by response, as the harness's own log on the runner's
 * computer records it (usage.responses): each kept once by its id, with the most read of it, for
 * threads, teammates and accounts of this workspace and computer only. From the first
 * response of a thread, teammate and account on, its turns' rows from their usage.updated events
 * count the turn but not its tokens (replaced): the stream's totals counted a turn split by
 * background work twice, and missed its subagents.
 */
export async function noteLoggedResponses(
  runner: { computerId: string; organizationId: string; workspaceId: string },
  responses: LoggedResponse[],
) {
  const merged = mergeResponses(responses)
  if (!merged.length) return
  const db = scoped(runner)
  const [threads, teammates, accounts] = await Promise.all([
    db.session.findMany({
      where: { id: { in: [...new Set(merged.map((r) => r.sessionId))] } },
      select: {
        id: true,
        origin: true,
        playbookRunId: true,
        projectId: true,
        scheduleId: true,
        _count: { select: { reviewsOf: true } },
      },
    }),
    db.teammate.findMany({
      where: { id: { in: [...new Set(merged.map((r) => r.teammateId))] } },
      select: { id: true },
    }),
    db.account.findMany({
      where: { computerId: runner.computerId },
      select: { id: true, memberId: true, provider: true, source: true },
    }),
  ])
  const threadById = new Map(threads.map((t) => [t.id, t]))
  const teammateIds = new Set(teammates.map((t) => t.id))
  // A clock far ahead is the computer's: the response goes in when it came.
  const latest = Date.now() + DAY_MS
  const rows = merged.flatMap((r) => {
    const thread = threadById.get(r.sessionId)
    // The computer's own login when it names none (a member's machine).
    const account = r.accountId
      ? accounts.find((a) => a.id === r.accountId)
      : accounts.find((a) => a.source === 'machine' && a.provider === r.provider)
    if (!thread || !teammateIds.has(r.teammateId) || account?.provider !== r.provider) return []
    const at = Date.parse(r.at) > latest ? new Date() : new Date(r.at)
    return [
      {
        id: randomUUID(),
        sessionId: r.sessionId,
        teammateId: r.teammateId,
        accountId: account.id,
        memberId: account.memberId,
        projectId: thread.projectId,
        scheduleId: thread.scheduleId,
        provider: r.provider,
        source: threadSource({ ...thread, reviews: thread._count.reviewsOf }),
        ...tokenColumns(r),
        at: at.toISOString(),
        responseId: r.id,
      },
    ]
  })
  if (!rows.length) return
  const column = <K extends keyof (typeof rows)[number]>(key: K) => rows.map((r) => r[key])
  await prisma.$transaction(async (tx) => {
    await lockUsage(tx, column('sessionId'))
    await tx.$executeRaw`
      INSERT INTO "TokenUsage" ("id", "organizationId", "workspaceId", "sessionId", "teammateId",
        "accountId", "memberId", "projectId", "scheduleId", "provider", "model", "source",
        "inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "reasoningTokens",
        "at", "responseId")
      SELECT u.id, ${runner.organizationId}, ${runner.workspaceId}, u.session, u.teammate,
        u.account, u.member, u.project, u.schedule, u.provider::"Harness", u.model, u.source,
        u.input, u.cache_read, u.cache_write, u.output, u.reasoning, u.at, u.response
      FROM unnest(
        ${column('id')}::text[], ${column('sessionId')}::text[], ${column('teammateId')}::text[],
        ${column('accountId')}::text[], ${column('memberId')}::text[], ${column('projectId')}::text[],
        ${column('scheduleId')}::text[], ${column('provider')}::text[], ${column('model')}::text[],
        ${column('source')}::text[], ${column('inputTokens')}::int[],
        ${column('cacheReadTokens')}::int[], ${column('cacheWriteTokens')}::int[],
        ${column('outputTokens')}::int[], ${column('reasoningTokens')}::int[],
        ${column('at')}::timestamp(3)[], ${column('responseId')}::text[]
      ) AS u(id, session, teammate, account, member, project, schedule, provider, model, source,
        input, cache_read, cache_write, output, reasoning, at, response)
      ON CONFLICT ("workspaceId", "responseId") DO UPDATE SET
        "inputTokens" = GREATEST("TokenUsage"."inputTokens", EXCLUDED."inputTokens"),
        "cacheReadTokens" = GREATEST("TokenUsage"."cacheReadTokens", EXCLUDED."cacheReadTokens"),
        "cacheWriteTokens" = GREATEST("TokenUsage"."cacheWriteTokens", EXCLUDED."cacheWriteTokens"),
        "outputTokens" = GREATEST("TokenUsage"."outputTokens", EXCLUDED."outputTokens"),
        "reasoningTokens" = GREATEST("TokenUsage"."reasoningTokens", EXCLUDED."reasoningTokens"),
        "model" = COALESCE("TokenUsage"."model", EXCLUDED."model"),
        "at" = LEAST("TokenUsage"."at", EXCLUDED."at")`
    // The turns these responses are of: counted by response from the first on.
    await tx.$executeRaw`
      UPDATE "TokenUsage" t SET "replaced" = true
      FROM (
        SELECT session, teammate, account, min(at) AS first
        FROM unnest(${column('sessionId')}::text[], ${column('teammateId')}::text[],
          ${column('accountId')}::text[], ${column('at')}::timestamp(3)[])
          AS u(session, teammate, account, at)
        GROUP BY 1, 2, 3
      ) r
      WHERE t."workspaceId" = ${runner.workspaceId} AND t."sessionId" = r.session
        AND t."teammateId" = r.teammate AND t."accountId" = r.account
        AND t."seq" IS NOT NULL AND t."responseId" IS NULL AND NOT t."replaced"
        AND t."at" >= r.first`
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
  // A turn counted by response keeps its row, to count the turn, but not its tokens (replaced).
  const counted = Prisma.sql`FILTER (WHERE NOT "replaced")`
  const sums = Prisma.sql`sum("inputTokens") ${counted}::bigint AS input,
    sum("cacheReadTokens") ${counted}::bigint AS cache_read,
    sum("cacheWriteTokens") ${counted}::bigint AS cache_write,
    sum("outputTokens") ${counted}::bigint AS output`
  // Turns and runs: a response's row is neither.
  const turns = Prisma.sql`count(*) FILTER (WHERE "responseId" IS NULL)`
  const grouped = (
    by: keyof typeof GROUP_COLUMNS,
    options: {
      limit?: number
      runs?: 'rows' | 'threads'
      notNull?: boolean
      /** Only what spent tokens: a model only a replaced row names spent none. */
      spent?: boolean
    } = {},
  ) => {
    const column = GROUP_COLUMNS[by]
    const runs = options.runs === 'threads' ? Prisma.sql`count(DISTINCT "sessionId")` : turns
    return prisma.$queryRaw<Row[]>`
      SELECT ${column} AS id, ${sums}, ${runs}::bigint AS runs
      FROM "TokenUsage"
      WHERE ${where}${options.notNull ? Prisma.sql` AND ${column} IS NOT NULL` : Prisma.empty}
      GROUP BY 1
      ${options.spent ? Prisma.sql`HAVING sum("inputTokens"::bigint + "outputTokens") ${counted} > 0` : Prisma.empty}
      ORDER BY coalesce(sum("inputTokens"::bigint + "outputTokens") ${counted}, 0) DESC
      ${options.limit ? Prisma.sql`LIMIT ${options.limit}` : Prisma.empty}`
  }
  const [total, daily, byProvider, bySource, byTeammate, byModel, byMember, threads, schedules] =
    await Promise.all([
      prisma.$queryRaw<
        Row[]
      >`SELECT NULL AS id, ${sums}, ${turns}::bigint AS runs FROM "TokenUsage" WHERE ${where}`,
      grouped('day'),
      grouped('provider'),
      grouped('source'),
      grouped('teammate', { limit: 20 }),
      grouped('model', { limit: 10, spent: true }),
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
