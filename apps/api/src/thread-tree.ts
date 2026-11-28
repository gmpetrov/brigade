// A thread's tree, for its details (docs/sub-threads.md): each sub-thread below it, at its level,
// with who works in it, where, what it is at, the line of a list it works on, what it produced
// and the tokens it spent; and the whole tree's tokens, counted as Usage counts them.
import { REPORT_START, clipReport, type ThreadTree, type TreeNodeState } from '@brigade/contracts'
import { inTree, reportOf } from './children.js'
import { prisma, Prisma, type ScopedDb } from './db.js'

const AT_WORK = new Set(['starting', 'running'])

/** What a sub-thread is at, in the words the Tree section shows. */
function stateOf(t: {
  status: string
  report: unknown
  doneAt: Date | null
  tickets: number
  childrenAtWork: number
}): TreeNodeState {
  if (t.tickets > 0 || t.status === 'waiting' || t.status === 'paused') return 'needs_you'
  const report = reportOf(t.report)
  if (AT_WORK.has(t.status)) return 'working'
  if (report)
    return report.status === 'needs_parent'
      ? 'needs_parent'
      : report.status === 'needs_person'
        ? 'needs_you'
        : report.status === 'failed'
          ? 'failed'
          : report.status === 'cancelled'
            ? 'cancelled'
            : 'done'
  if (t.status === 'failed') return 'failed'
  if (t.childrenAtWork > 0) return 'waiting'
  return t.doneAt ? 'done' : 'idle'
}

/** Tokens each of these threads spent, as Usage counts them (input and output, none replaced). */
async function tokensOf(workspaceId: string, ids: string[]) {
  if (!ids.length) return new Map<string, number>()
  const rows = await prisma.$queryRaw<{ sessionId: string; used: bigint | null }[]>`
    SELECT "sessionId", sum("inputTokens"::bigint + "outputTokens") AS used FROM "TokenUsage"
    WHERE "workspaceId" = ${workspaceId} AND NOT replaced AND "sessionId" IN (${Prisma.join(ids)})
    GROUP BY "sessionId"`
  return new Map(rows.map((r) => [r.sessionId, Number(r.used ?? 0)]))
}

/**
 * The tree below a thread: its sub-threads and theirs (the reviews of their pull requests too),
 * depth first, each after its parent, newest first among siblings. Null when it has none.
 */
export async function threadTree(
  db: ScopedDb,
  workspaceId: string,
  thread: { id: string; parentId: string | null; rootId: string | null },
): Promise<ThreadTree> {
  const parent = thread.parentId
    ? await db.session.findFirst({
        where: { id: thread.parentId },
        select: { parentId: true, rootId: true },
      })
    : null
  const level = !thread.parentId ? 0 : parent?.parentId ? 2 : 1
  // The top: its own rootId, else (a sub-thread from before rootId) its parent's, or its parent.
  const rootId = !thread.parentId
    ? thread.id
    : (thread.rootId ?? parent?.rootId ?? parent?.parentId ?? thread.parentId)
  const select = {
    id: true,
    title: true,
    status: true,
    parentId: true,
    origin: true,
    report: true,
    doneAt: true,
    createdAt: true,
    teammate: { select: { id: true, name: true } },
    computer: { select: { id: true, name: true, kind: true } },
    _count: { select: { tickets: { where: { status: 'open' as const } } } },
  } as const
  // Its children, then theirs: two levels at most below the top (SUBTHREAD_DEPTH).
  const first = await db.session.findMany({
    where: { parentId: thread.id, origin: 'child', chiefDecisionId: null },
    select,
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
  const second = first.length
    ? await db.session.findMany({
        where: {
          parentId: { in: first.map((c) => c.id) },
          origin: 'child',
          chiefDecisionId: null,
        },
        select,
        orderBy: { createdAt: 'desc' },
        take: 200,
      })
    : []
  const rows = [...first, ...second]
  const ids = rows.map((r) => r.id)
  const [tokens, pulls, sent, saved, lines, treeIds] = await Promise.all([
    tokensOf(workspaceId, [thread.id, ...ids]),
    ids.length
      ? db.pullRequest.findMany({
          where: { sessionId: { in: ids } },
          select: { sessionId: true, repository: true, number: true, state: true },
        })
      : [],
    ids.length
      ? db.attachment.groupBy({
          by: ['sessionId'],
          where: { sessionId: { in: ids }, source: 'teammate', status: 'ready' },
          _count: { _all: true },
        })
      : [],
    ids.length
      ? db.documentVersion.findMany({
          where: { sessionId: { in: ids } },
          select: { sessionId: true, path: true },
          distinct: ['sessionId', 'documentId'],
        })
      : [],
    ids.length
      ? db.listItemThread.findMany({
          where: { sessionId: { in: ids } },
          select: { sessionId: true, item: { select: { text: true } } },
        })
      : [],
    // The whole tree's threads, for its total: from the top, whatever this thread's level.
    db.session.findMany({ where: inTree(rootId), select: { id: true } }),
  ])
  const total = [
    ...(await tokensOf(workspaceId, [rootId, ...treeIds.map((t) => t.id)])).values(),
  ].reduce((a, b) => a + b, 0)
  const atWorkUnder = (id: string) =>
    second.filter((c) => c.parentId === id && AT_WORK.has(c.status)).length
  const node = (r: (typeof rows)[number], at: number) => {
    const report = reportOf(r.report)
    return {
      id: r.id,
      title: r.title,
      parentId: r.parentId!,
      level: at,
      teammate: r.teammate,
      computer: r.computer,
      status: r.status,
      state: stateOf({
        status: r.status,
        report: r.report,
        doneAt: r.doneAt,
        tickets: r._count.tickets,
        childrenAtWork: atWorkUnder(r.id),
      }),
      report: report
        ? { status: report.status, summary: clipReport(report.summary, REPORT_START) }
        : null,
      line: lines.find((l) => l.sessionId === r.id)?.item.text ?? null,
      pullRequests: pulls
        .filter((p) => p.sessionId === r.id)
        .map((p) => ({
          repository: p.repository,
          number: p.number,
          state: p.state,
          url: `https://github.com/${p.repository}/pull/${p.number}`,
        })),
      documents: saved.filter((d) => d.sessionId === r.id).map((d) => d.path),
      files: sent.find((f) => f.sessionId === r.id)?._count._all ?? 0,
      tokens: tokens.get(r.id) ?? 0,
      createdAt: r.createdAt.toISOString(),
    }
  }
  const nodes: ReturnType<typeof node>[] = []
  for (const c of first) {
    nodes.push(node(c, level + 1))
    for (const g of second.filter((s) => s.parentId === c.id)) nodes.push(node(g, level + 2))
  }
  const below = nodes.reduce((a, n) => a + n.tokens, 0)
  return {
    level,
    rootId,
    nodes,
    tokens: { thread: tokens.get(thread.id) ?? 0, below, tree: total },
  }
}
