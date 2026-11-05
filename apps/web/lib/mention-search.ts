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

/** How many threads the search may add below those the menu shows: as many as it shows. */
const FOUND_MAX = MENTION_GROUPS.find((g) => g.kind === 'thread')!.max

/** What the menu matches: the query in any case, without the spaces around it. */
const typed = (query: string) => query.trim().toLowerCase()

/** How well a name matches the query: the name itself, then one that starts with it, then one that holds it. */
const tier = (label: string, q: string) => {
  const name = label.toLowerCase()
  return name === q ? 0 : name.startsWith(q) ? 1 : name.includes(q) ? 2 : 3
}

/** Matches for a query, grouped by kind; the name typed first, then names that start with it. */
export function searchMentions(options: MentionOption[], query: string) {
  const q = typed(query)
  return MENTION_GROUPS.flatMap((g) =>
    options
      .filter((o) => o.kind === g.kind && o.label.toLowerCase().includes(q))
      // A stable sort: within a tier, the order the page has them in.
      .sort((a, b) => tier(a.label, q) - tier(b.label, q))
      .slice(0, g.max),
  )
}

/** The menu asks the search from this many characters: fewer would name too many threads to help. */
const THREAD_SEARCH_MIN = 2
/** How long typing pauses before the menu asks the search, as ⌘K waits. */
export const THREAD_SEARCH_DELAY = 150

/** Whether the menu asks the search for the threads this query names. */
export const searchesThreads = (query: string) => typed(query).length >= THREAD_SEARCH_MIN

/** The threads the search found for a query. */
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

/** Whether these are what the search found for this query. */
export const foundFor = (found: FoundThreads | undefined, query: string): found is FoundThreads =>
  found?.query === typed(query)

/**
 * The menu's matches with the threads the search found that it does not show: below the threads
 * it shows, which keep their rows, the title typed first, then those that start with it, then
 * those that hold it, then the rest the search found (despite a typo, or by their summary), as
 * the search ranked them, as many as the group shows. Nothing the menu shows moves or goes: the
 * row selected stays the one Enter picks, and an older thread whose title is the query still
 * shows when recent ones fill the group.
 */
export function withFoundThreads(
  items: MentionOption[],
  found: MentionOption[],
  query: string,
): MentionOption[] {
  const ids = new Set(items.flatMap((o) => (o.kind === 'thread' ? [o.id] : [])))
  const added: MentionOption[] = []
  for (const o of found)
    if (o.kind === 'thread' && !ids.has(o.id)) {
      ids.add(o.id)
      added.push(o)
    }
  if (!added.length) return items
  const q = typed(query)
  // A stable sort: within a tier, as the search ranked them.
  const best = added.sort((a, b) => tier(a.label, q) - tier(b.label, q)).slice(0, FOUND_MAX)
  return MENTION_GROUPS.flatMap((g) => {
    const shown = items.filter((o) => o.kind === g.kind)
    return g.kind === 'thread' ? [...shown, ...best] : shown
  })
}
