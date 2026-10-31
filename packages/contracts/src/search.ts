import { z } from 'zod'

/** What a dashboard search result is; the web maps each to its page. */
export const SearchKind = z.enum([
  'thread',
  'teammate',
  'task',
  'automation',
  'ticket',
  'pull_request',
  'connection',
  'trigger',
  'credential',
  'account',
  'computer',
  'file',
  'memory',
])
export type SearchKind = z.infer<typeof SearchKind>

/** One thing in the workspace that matches a search, as the member may see it. */
export const SearchResult = z.object({
  kind: SearchKind,
  id: z.string(),
  title: z.string(),
  /** A short line under the title: whose, where, what kind. */
  detail: z.string().nullable(),
  /** Matching text from inside a file, memory or thread summary, with matches between « and ». */
  snippet: z.string().nullable(),
  /** The thread it belongs to (a ticket's). */
  threadId: z.string().nullable(),
  /** Pull requests open on their own page. */
  pull: z.object({ repository: z.string(), number: z.number() }).nullable(),
  /** How well it matches (SCORE), to rank results of every kind together. */
  score: z.number(),
})
export type SearchResult = z.infer<typeof SearchResult>

/** How well a result matches what was typed, highest first; see titleScore. */
export const SCORE = {
  /** Its name is what was typed. */
  exact: 100,
  /** Its name starts with what was typed. */
  prefix: 90,
  /** Each typed word starts a word of its name. */
  words: 80,
  /** Each typed word is somewhere in its name. */
  inside: 70,
  /** A word only close to one of its name (a typo), or found in another field. */
  near: 40,
  /** Found only in its text: a file's content, a thread's summary, memory. */
  text: 20,
} as const

/** Lower case, accents dropped, anything but letters and digits a space: "Launch-Checklist.md" is "launch checklist md". */
export function searchText(text: string) {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/**
 * How well a name matches what was typed, by SCORE's tiers. A file's name is its
 * last part without its extension, so "launch checklist" is an exact match for
 * "Projects/Brigade/launch-checklist.md"; its whole path still counts.
 */
export function titleScore(query: string, title: string, kind?: SearchKind) {
  const typed = searchText(query)
  if (!typed) return 0
  const words = typed.split(' ')
  const names = [searchText(title)]
  if (kind === 'file')
    names.unshift(
      searchText(
        title
          .split('/')
          .pop()!
          .replace(/\.[^.]+$/, ''),
      ),
    )
  let best: number = SCORE.near
  for (const name of names) {
    const parts = name.split(' ')
    if (name === typed) return SCORE.exact
    if (name.startsWith(typed)) best = Math.max(best, SCORE.prefix)
    else if (words.every((w) => parts.some((p) => p.startsWith(w))))
      best = Math.max(best, SCORE.words)
    else if (words.every((w) => name.includes(w))) best = Math.max(best, SCORE.inside)
  }
  return best
}
