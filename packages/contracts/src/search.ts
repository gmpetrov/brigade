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
})
export type SearchResult = z.infer<typeof SearchResult>
