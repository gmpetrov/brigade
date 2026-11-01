// The dashboard's ⌘K search: everything a member can see, by name, plus the
// full text of library files, memory and thread summaries. Each kind follows
// the same rules as its own list, so search never shows more than the pages do.
// Names also match despite a typo (pg_trgm, see the search_trigrams migration),
// and each result gets a score so the dashboard ranks every kind together.
import { SCORE, titleScore, type SearchResult } from '@brigade/contracts'
import { Hono } from 'hono'
import { usableBy } from '../account-sharing.js'
import { prisma, Prisma, type Scope } from '../db.js'
import { search as searchDocuments } from '../library.js'
import { requireUser, requireWorkspace, type AppEnv } from '../scope.js'

/** Per kind; the popup shows a handful of each. */
const EACH = 6

/** Every word must appear in one of the fields, in any case. */
function matching(words: string[], fields: string[]) {
  return {
    AND: words.map((word) => ({
      OR: fields.map((field) => ({ [field]: { contains: word, mode: 'insensitive' as const } })),
    })),
  }
}

/** Shorter words have too few trigrams to tell a typo from another word. */
const NEAR_MIN = 3
const like = (word: string) => `%${word.replace(/[\\%_]/g, '\\$&')}%`
const column = (name: string) => Prisma.raw(`"${name}"`)

/** A name as titleScore reads it: lower case, spaces and punctuation one space. */
const plain = (name: Prisma.Sql) =>
  Prisma.sql`btrim(regexp_replace(lower(${name}), '[[:space:][:punct:]]+', ' ', 'g'))`

/** A file's name: its path's last part without its extension. */
const FILE_NAME = Prisma.sql`regexp_replace(regexp_replace("path", '^.*/', ''), '[.][^.]*$', '')`

/**
 * Ids of a table's rows in this workspace where every word is in one of `fields`,
 * or close to a word of `near` (`<%`, pg_trgm's word similarity): "cecklist" finds
 * "launch-checklist.md". Best named first, as titleScore ranks them (the name as
 * typed, then starting with it, then each word starting one of its words), so that
 * newer rows that only share the words never push it past the limit; then rows
 * where every word is there as typed, the closest, and by `order`. Table and column
 * names are this file's, never input.
 */
async function nearly(
  scope: Scope,
  input: {
    table: string
    near: string
    fields: string[]
    words: string[]
    /** What titleScore reads as its name, when not `near` itself. */
    name?: Prisma.Sql
    where?: Prisma.Sql
    order: string
    take?: number
  },
): Promise<string[]> {
  const near = column(input.near)
  const name = plain(input.name ?? near)
  const typed = input.words.join(' ').toLowerCase()
  const starts = Prisma.join(
    input.words.map((word) => Prisma.sql`(' ' || ${name}) LIKE ${`% ${word.toLowerCase()}%`}`),
    ' AND ',
  )
  const exact = input.words.map(
    (word) =>
      Prisma.sql`(${Prisma.join(
        input.fields.map((field) => Prisma.sql`${column(field)} ILIKE ${like(word)}`),
        ' OR ',
      )})`,
  )
  const close = input.words.filter((word) => word.length >= NEAR_MIN)
  const each = input.words.map((word, i) =>
    word.length >= NEAR_MIN ? Prisma.sql`(${exact[i]} OR ${word} <% ${near})` : exact[i],
  )
  // Only words long enough to be near another rank by closeness. Without any, the term is left
  // out: a bare `0` in ORDER BY is read as a column position, and Postgres rejects it.
  const similarity = close.length
    ? Prisma.sql`${Prisma.join(
        close.map((word) => Prisma.sql`word_similarity(${word}, ${near})`),
        ' + ',
      )} DESC,`
    : Prisma.empty
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM ${column(input.table)}
    WHERE "organizationId" = ${scope.organizationId}
      AND "workspaceId" = ${scope.workspaceId}
      ${input.where ? Prisma.sql`AND ${input.where}` : Prisma.empty}
      AND ${Prisma.join(each, ' AND ')}
    ORDER BY ${name} = ${typed} DESC, ${name} LIKE ${`${typed}%`} DESC, (${starts}) DESC,
      (${Prisma.join(exact, ' AND ')}) DESC, ${similarity} ${Prisma.raw(input.order)}
    LIMIT ${input.take ?? EACH}`
  return rows.map((r) => r.id)
}

/** Rows in the order of their ids. */
function inOrder<T extends { id: string }>(ids: string[], rows: T[]) {
  const byId = new Map(rows.map((r) => [r.id, r]))
  return ids.flatMap((id) => byId.get(id) ?? [])
}

const result = (
  r: Pick<SearchResult, 'kind' | 'id' | 'title' | 'score'> & Partial<SearchResult>,
): SearchResult => ({ detail: null, snippet: null, threadId: null, pull: null, ...r })

const CONNECTION_KIND: Record<string, string> = {
  gmail: 'Gmail',
  google_calendar: 'Google Calendar',
  google_drive: 'Google Drive',
  google_docs: 'Google Docs',
  google_sheets: 'Google Sheets',
  google_search_console: 'Google Search Console',
  google_analytics: 'Google Analytics',
  stripe: 'Stripe',
  github: 'GitHub',
  webhook: 'Custom app',
}

export const search = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)

  .get('/', async (c) => {
    const { db, scope } = c.var
    const query = (c.req.query('q') ?? '').trim().slice(0, 200)
    // "launch-checklist" is "launch" and "checklist", as in a file's name.
    const words = query
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean)
      .slice(0, 8)
    if (words.length === 0) return c.json([])
    // "#12" or "12" finds pull request 12.
    const number = /^#?\d+$/.test(query) ? Number(query.replace('#', '')) : null
    const score = (title: string, kind?: SearchResult['kind']) => titleScore(query, title, kind)

    const [
      threadIds,
      teammates,
      taskIds,
      schedules,
      ticketIds,
      pullIds,
      connections,
      triggers,
      credentials,
      accounts,
      computers,
      documents,
    ] = await Promise.all([
      nearly(scope, {
        table: 'Session',
        near: 'title',
        fields: ['title'],
        words,
        order: '"updatedAt" DESC',
      }),
      db.teammate.findMany({
        where: { archivedAt: null, ...matching(words, ['name', 'instructions']) },
        select: { id: true, name: true, harness: true },
        orderBy: { createdAt: 'asc' },
        take: EACH,
      }),
      nearly(scope, {
        table: 'Task',
        near: 'title',
        fields: ['title', 'description'],
        words,
        order: '"updatedAt" DESC',
      }),
      db.schedule.findMany({
        where: matching(words, ['title', 'instructions']),
        select: { id: true, title: true, teammate: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        take: EACH,
      }),
      nearly(scope, {
        table: 'Ticket',
        near: 'title',
        fields: ['title'],
        words,
        order: '"createdAt" DESC',
      }),
      nearly(scope, {
        table: 'PullRequest',
        near: 'title',
        fields: ['title', 'repository', 'headRef'],
        words,
        order: '"updatedAt" DESC',
      }),
      db.connection.findMany({
        where: { status: { not: 'removed' }, ...matching(words, ['label', 'externalAccount']) },
        select: { id: true, label: true, kind: true, externalAccount: true },
        orderBy: { createdAt: 'asc' },
        take: EACH,
      }),
      db.trigger.findMany({
        where: matching(words, ['label', 'event']),
        select: { id: true, label: true, teammate: { select: { name: true } } },
        orderBy: { createdAt: 'asc' },
        take: EACH,
      }),
      db.credential.findMany({
        where: matching(words, ['name']),
        select: { id: true, name: true, kind: true },
        orderBy: { name: 'asc' },
        take: EACH,
      }),
      // The AI accounts this member may run on (src/account-sharing.ts).
      db.account.findMany({
        where: { AND: [usableBy(scope.memberId), matching(words, ['label', 'email'])] },
        select: { id: true, label: true, email: true, provider: true },
        orderBy: { createdAt: 'asc' },
        take: EACH,
      }),
      // The cloud computer, and this member's own machines.
      db.computer.findMany({
        where: {
          status: { not: 'destroyed' },
          AND: [
            { OR: [{ kind: 'cloud' }, { memberId: scope.memberId }] },
            matching(words, ['name']),
          ],
        },
        select: { id: true, name: true, kind: true },
        orderBy: { createdAt: 'asc' },
        take: EACH,
      }),
      searchDocuments(scope, { query, limit: EACH * 2, memberId: scope.memberId }),
    ])
    const [threads, tasks, tickets, pulls] = await Promise.all([
      db.session
        .findMany({
          where: { id: { in: threadIds } },
          select: { id: true, title: true, teammate: { select: { name: true } } },
        })
        .then((rows) => inOrder(threadIds, rows)),
      db.task
        .findMany({
          where: { id: { in: taskIds } },
          select: {
            id: true,
            title: true,
            completedAt: true,
            trashedAt: true,
            teammate: { select: { name: true } },
          },
        })
        .then((rows) => inOrder(taskIds, rows)),
      db.ticket
        .findMany({
          where: { id: { in: ticketIds } },
          select: { id: true, title: true, status: true, sessionId: true },
        })
        .then((rows) => inOrder(ticketIds, rows)),
      db.pullRequest
        .findMany({
          where: number ? { OR: [{ number }, { id: { in: pullIds } }] } : { id: { in: pullIds } },
          select: { id: true, title: true, repository: true, number: true, state: true },
          orderBy: { updatedAt: 'desc' },
          take: EACH * 2,
        })
        .then((rows) => {
          const found = inOrder(pullIds, rows)
          return [...rows.filter((p) => p.number === number), ...found]
            .filter((p, i, all) => all.findIndex((q) => q.id === p.id) === i)
            .slice(0, EACH)
        }),
    ])

    // A thread found by its summary joins the threads, with what matched.
    const threadResults = threads.map((t) =>
      result({
        kind: 'thread',
        id: t.id,
        title: t.title,
        detail: t.teammate.name,
        score: score(t.title),
      }),
    )
    const files: SearchResult[] = []
    const memory: SearchResult[] = []
    for (const hit of documents) {
      if (hit.kind === 'thread_summary' && hit.sessionId) {
        const found = threadResults.find((t) => t.id === hit.sessionId)
        if (found) found.snippet = hit.snippet
        else if (threadResults.length < EACH * 2)
          threadResults.push(
            result({
              kind: 'thread',
              id: hit.sessionId,
              title: hit.title.replace(/^Thread: /, ''),
              detail: 'From its summary',
              snippet: hit.snippet,
              score: SCORE.text,
            }),
          )
      } else if (hit.kind === 'library') {
        // Its text matched; its name may too.
        const named = score(hit.path, 'file')
        files.push(
          result({
            kind: 'file',
            id: hit.documentId,
            title: hit.path,
            snippet: hit.snippet,
            score: named > SCORE.near ? named : SCORE.text,
          }),
        )
      } else
        memory.push(
          result({
            kind: 'memory',
            id: hit.documentId,
            title: hit.title,
            snippet: hit.snippet,
            score: SCORE.text,
          }),
        )
    }
    // Files whose path matches, though their text may not, or is close to it. Never one in the trash.
    const pathIds = await nearly(scope, {
      table: 'Document',
      near: 'path',
      name: FILE_NAME,
      fields: ['path'],
      words,
      where: Prisma.sql`kind = 'library' AND "deletedAt" IS NULL`,
      order: '"updatedAt" DESC',
      take: EACH + files.length,
    })
    const byPath = inOrder(
      pathIds,
      await db.document.findMany({
        where: { id: { in: pathIds }, kind: 'library', deletedAt: null },
        select: { id: true, path: true },
      }),
    )
    for (const f of byPath) {
      const found = files.find((x) => x.id === f.id)
      if (found) found.score = Math.max(found.score, score(f.path, 'file'))
      else
        files.push(result({ kind: 'file', id: f.id, title: f.path, score: score(f.path, 'file') }))
    }
    // Best named first; the order found within a score.
    const ranked = (list: SearchResult[]) => [...list].sort((a, b) => b.score - a.score)

    return c.json<SearchResult[]>([
      ...teammates.map((t) =>
        result({
          kind: 'teammate',
          id: t.id,
          title: t.name,
          detail: t.harness === 'codex' ? 'Codex' : 'Claude',
          score: score(t.name),
        }),
      ),
      ...ranked(threadResults),
      ...ranked(
        tasks.map((t) =>
          result({
            kind: 'task',
            id: t.id,
            title: t.title,
            detail: [
              t.teammate?.name ?? 'Backlog',
              t.completedAt && 'done',
              t.trashedAt && 'in the Trash',
            ]
              .filter(Boolean)
              .join(' · '),
            score: score(t.title),
          }),
        ),
      ),
      ...ranked(
        pulls.map((p) =>
          result({
            kind: 'pull_request',
            id: p.id,
            title: p.title,
            detail: `${p.repository}#${p.number} · ${p.state}`,
            pull: { repository: p.repository, number: p.number },
            score: p.number === number ? SCORE.exact : score(p.title),
          }),
        ),
      ),
      ...ranked(
        tickets.map((t) =>
          result({
            kind: 'ticket',
            id: t.id,
            title: t.title,
            detail: t.status,
            threadId: t.sessionId,
            score: score(t.title),
          }),
        ),
      ),
      ...schedules.map((s) =>
        result({
          kind: 'automation',
          id: s.id,
          title: s.title,
          detail: s.teammate.name,
          score: score(s.title),
        }),
      ),
      ...ranked(files).slice(0, EACH),
      ...memory.slice(0, EACH),
      ...connections.map((x) =>
        result({
          kind: 'connection',
          id: x.id,
          title: x.label,
          detail: [CONNECTION_KIND[x.kind] ?? x.kind, x.externalAccount]
            .filter(Boolean)
            .join(' · '),
          score: score(x.label),
        }),
      ),
      ...triggers.map((t) =>
        result({
          kind: 'trigger',
          id: t.id,
          title: t.label,
          detail: t.teammate.name,
          score: score(t.label),
        }),
      ),
      ...credentials.map((x) =>
        result({
          kind: 'credential',
          id: x.id,
          title: x.name,
          detail: x.kind.replace('_', ' '),
          score: score(x.name),
        }),
      ),
      ...accounts.map((a) =>
        result({
          kind: 'account',
          id: a.id,
          title: a.label,
          detail: [a.provider === 'codex' ? 'Codex' : 'Claude', a.email]
            .filter(Boolean)
            .join(' · '),
          score: score(a.label),
        }),
      ),
      ...computers.map((x) => {
        const title = x.kind === 'cloud' ? 'Cloud computer' : x.name
        return result({
          kind: 'computer',
          id: x.id,
          title,
          detail: x.kind === 'cloud' ? 'Cloud' : 'Your machine',
          score: score(title),
        })
      }),
    ])
  })
