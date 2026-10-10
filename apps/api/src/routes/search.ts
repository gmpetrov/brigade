// The dashboard's ⌘K search: everything a member can see, by name, plus the
// full text of library files, memory and thread summaries. Each kind follows
// the same rules as its own list, so search never shows more than the pages do.
import type { SearchResult } from '@brigade/contracts'
import { Hono } from 'hono'
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

const result = (
  r: Pick<SearchResult, 'kind' | 'id' | 'title'> & Partial<SearchResult>,
): SearchResult => ({ detail: null, snippet: null, threadId: null, pull: null, ...r })

const CONNECTION_KIND: Record<string, string> = {
  gmail: 'Gmail',
  google_calendar: 'Google Calendar',
  stripe: 'Stripe',
  github: 'GitHub',
  webhook: 'Custom app',
}

export const search = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)

  .get('/', async (c) => {
    const { db, scope } = c.var
    const query = (c.req.query('q') ?? '').trim().slice(0, 200)
    const words = query.split(/\s+/).filter(Boolean).slice(0, 8)
    if (words.length === 0) return c.json([])
    // "#12" or "12" finds pull request 12.
    const number = /^#?\d+$/.test(query) ? Number(query.replace('#', '')) : null

    const [
      threads,
      teammates,
      tasks,
      schedules,
      tickets,
      pulls,
      connections,
      triggers,
      credentials,
      accounts,
      computers,
      documents,
    ] = await Promise.all([
      db.session.findMany({
        where: matching(words, ['title']),
        select: { id: true, title: true, teammate: { select: { name: true } } },
        orderBy: { updatedAt: 'desc' },
        take: EACH,
      }),
      db.teammate.findMany({
        where: { archivedAt: null, ...matching(words, ['name', 'instructions']) },
        select: { id: true, name: true, harness: true },
        orderBy: { createdAt: 'asc' },
        take: EACH,
      }),
      db.task.findMany({
        where: matching(words, ['title', 'description']),
        select: { id: true, title: true, completedAt: true, teammate: { select: { name: true } } },
        orderBy: { updatedAt: 'desc' },
        take: EACH,
      }),
      db.schedule.findMany({
        where: matching(words, ['title', 'instructions']),
        select: { id: true, title: true, teammate: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        take: EACH,
      }),
      db.ticket.findMany({
        where: matching(words, ['title']),
        select: { id: true, title: true, status: true, sessionId: true },
        orderBy: { createdAt: 'desc' },
        take: EACH,
      }),
      db.pullRequest.findMany({
        where: number
          ? { OR: [{ number }, matching(words, ['title', 'repository', 'headRef'])] }
          : matching(words, ['title', 'repository', 'headRef']),
        select: { id: true, title: true, repository: true, number: true, state: true },
        orderBy: { updatedAt: 'desc' },
        take: EACH,
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
      // A member's AI accounts are theirs alone.
      db.account.findMany({
        where: { memberId: scope.memberId, ...matching(words, ['label', 'email']) },
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

    // A thread found by its summary joins the threads, with what matched.
    const threadResults = threads.map((t) =>
      result({ kind: 'thread', id: t.id, title: t.title, detail: t.teammate.name }),
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
            }),
          )
      } else if (hit.kind === 'library')
        files.push(
          result({ kind: 'file', id: hit.documentId, title: hit.path, snippet: hit.snippet }),
        )
      else
        memory.push(
          result({ kind: 'memory', id: hit.documentId, title: hit.title, snippet: hit.snippet }),
        )
    }
    // Files whose path matches, though their text may not.
    const byPath = await db.document.findMany({
      where: {
        kind: 'library',
        id: { notIn: files.map((f) => f.id) },
        ...matching(words, ['path']),
      },
      select: { id: true, path: true },
      orderBy: { updatedAt: 'desc' },
      take: EACH,
    })
    files.unshift(...byPath.map((f) => result({ kind: 'file', id: f.id, title: f.path })))

    return c.json<SearchResult[]>([
      ...teammates.map((t) =>
        result({
          kind: 'teammate',
          id: t.id,
          title: t.name,
          detail: t.harness === 'codex' ? 'Codex' : 'Claude',
        }),
      ),
      ...threadResults,
      ...tasks.map((t) =>
        result({
          kind: 'task',
          id: t.id,
          title: t.title,
          detail: t.completedAt ? `${t.teammate.name} · done` : t.teammate.name,
        }),
      ),
      ...pulls.map((p) =>
        result({
          kind: 'pull_request',
          id: p.id,
          title: p.title,
          detail: `${p.repository}#${p.number} · ${p.state}`,
          pull: { repository: p.repository, number: p.number },
        }),
      ),
      ...tickets.map((t) =>
        result({
          kind: 'ticket',
          id: t.id,
          title: t.title,
          detail: t.status,
          threadId: t.sessionId,
        }),
      ),
      ...schedules.map((s) =>
        result({ kind: 'automation', id: s.id, title: s.title, detail: s.teammate.name }),
      ),
      ...files.slice(0, EACH),
      ...memory.slice(0, EACH),
      ...connections.map((x) =>
        result({
          kind: 'connection',
          id: x.id,
          title: x.label,
          detail: [CONNECTION_KIND[x.kind] ?? x.kind, x.externalAccount]
            .filter(Boolean)
            .join(' · '),
        }),
      ),
      ...triggers.map((t) =>
        result({ kind: 'trigger', id: t.id, title: t.label, detail: t.teammate.name }),
      ),
      ...credentials.map((x) =>
        result({ kind: 'credential', id: x.id, title: x.name, detail: x.kind.replace('_', ' ') }),
      ),
      ...accounts.map((a) =>
        result({
          kind: 'account',
          id: a.id,
          title: a.label,
          detail: [a.provider === 'codex' ? 'Codex' : 'Claude', a.email]
            .filter(Boolean)
            .join(' · '),
        }),
      ),
      ...computers.map((x) =>
        result({
          kind: 'computer',
          id: x.id,
          title: x.kind === 'cloud' ? 'Workspace computer' : x.name,
          detail: x.kind === 'cloud' ? 'Cloud' : 'Your machine',
        }),
      ),
    ])
  })
