// What the `@` menu offers for what follows the `@` (a message's composer, a library
// document's editor): what the page loaded, matched as you type, and the threads the
// workspace search finds, which join them once it answers. The page loads only the latest
// threads (`/threads` gives the 100 last active), so an older one is found only by the
// search, ⌘K's (routes/search.ts): every thread of the workspace, archived ones and
// sub-threads too, by its title despite a typo, or by its summary.
import type { Mention, MentionKind, SearchResult } from '@brigade/contracts'
import type { Connection } from '@/lib/api'

/** Something to mention, with what the menu shows beside it. */
export type MentionOption = Mention & { hint?: string; connectionKind?: Connection['kind'] }

export const MENTION_GROUPS: { kind: MentionKind; title: string; max: number }[] = [
  { kind: 'teammate', title: 'Teammates', max: 5 },
  { kind: 'project', title: 'Projects', max: 5 },
  { kind: 'connection', title: 'Apps', max: 5 },
  { kind: 'repository', title: 'Repositories', max: 5 },
  { kind: 'design-system', title: 'Design systems', max: 5 },
  { kind: 'design', title: 'Designs', max: 5 },
  { kind: 'document', title: 'Library', max: 5 },
  { kind: 'credential', title: 'Secrets', max: 5 },
  { kind: 'thread', title: 'Threads', max: 4 },
  { kind: 'computer', title: 'Computers', max: 3 },
]

const THREADS_MAX = MENTION_GROUPS.find((g) => g.kind === 'thread')!.max

/** What the menu matches: the query in any case, without the spaces around it. */
const typed = (query: string) => query.trim().toLowerCase()

/** Matches for a query, grouped by kind; names that start with it first. */
export function searchMentions(options: MentionOption[], query: string) {
  const q = typed(query)
  return MENTION_GROUPS.flatMap((g) =>
    options
      .filter((o) => o.kind === g.kind && o.label.toLowerCase().includes(q))
      .sort(
        (a, b) =>
          Number(!a.label.toLowerCase().startsWith(q)) -
          Number(!b.label.toLowerCase().startsWith(q)),
      )
      .slice(0, g.max),
  )
}

/** The menu asks the search from this many characters: fewer would name too many threads to help. */
const THREAD_SEARCH_MIN = 2
/** How long typing pauses before the menu asks the search, as ⌘K waits. */
export const THREAD_SEARCH_DELAY = 150

/** Whether the menu asks the search for the threads this query names. */
export const searchesThreads = (query: string) => typed(query).length >= THREAD_SEARCH_MIN

/** The threads the search found for a query, kept for the next ones as long as they still match. */
export type FoundThreads = { query: string; threads: MentionOption[] }

/** The threads among what the search found for a query, as the menu shows them; never `exclude`. */
export function foundThreads(
  query: string,
  results: SearchResult[],
  exclude?: string,
): FoundThreads {
  return {
    query: typed(query),
    threads: results.flatMap((r) =>
      r.kind === 'thread' && r.id !== exclude
        ? [{ kind: 'thread' as const, id: r.id, label: r.title, hint: r.detail ?? undefined }]
        : [],
    ),
  }
}

/** Whether the search answered this query already. */
export const foundFor = (found: FoundThreads | undefined, query: string) =>
  found?.query === typed(query)

/**
 * The threads found for this query, or for an earlier one those whose title still holds it:
 * typing on keeps them in the menu while the search looks again.
 */
export function stillFound(found: FoundThreads | undefined, query: string): MentionOption[] {
  if (!found) return []
  if (foundFor(found, query)) return found.threads
  const q = typed(query)
  return found.threads.filter((t) => t.label.toLowerCase().includes(q))
}

/**
 * The menu's matches with the threads the search found among its threads: those whose title
 * starts with the query first, then those that hold it, then the rest the search found (despite
 * a typo, or by their summary), each in the order it came (those already shown, then as the
 * search ranked them), as many as the group shows. Threads already shown keep their order.
 */
export function withFoundThreads(
  items: MentionOption[],
  found: MentionOption[],
  query: string,
): MentionOption[] {
  const shown = items.filter((o) => o.kind === 'thread')
  const ids = new Set(shown.map((o) => o.id))
  const added: MentionOption[] = []
  for (const o of found)
    if (o.kind === 'thread' && !ids.has(o.id)) {
      ids.add(o.id)
      added.push(o)
    }
  if (!added.length) return items
  const q = typed(query)
  const rank = ({ label }: MentionOption) =>
    label.toLowerCase().startsWith(q) ? 0 : label.toLowerCase().includes(q) ? 1 : 2
  // A stable sort: within a rank, the order they came in.
  const threads = [...shown, ...added].sort((a, b) => rank(a) - rank(b)).slice(0, THREADS_MAX)
  return MENTION_GROUPS.flatMap((g) =>
    g.kind === 'thread' ? threads : items.filter((o) => o.kind === g.kind),
  )
}
