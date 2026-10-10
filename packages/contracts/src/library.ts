// The document library and memory: files in one shared folder per workspace,
// Markdown memory at three levels, and one search over both.
import { z } from 'zod'

/** Largest file the library takes. */
export const LIBRARY_FILE_MAX = 25 * 1024 * 1024
/** Largest file a teammate saves to the library in one call. */
export const LIBRARY_SAVE_MAX = 10 * 1024 * 1024
/** Longest memory file; teammates are asked to keep theirs much shorter. */
export const MEMORY_MAX = 50_000

export const LibraryAccess = z.enum(['read', 'read_write'])
export type LibraryAccess = z.infer<typeof LibraryAccess>

/**
 * A library path: folders separated by "/", no "." or ".." segments, no
 * leading slash. The same path on every computer the library syncs to.
 */
export const LibraryPath = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .transform((p) => p.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/'))
  .refine(
    (p) =>
      p.length > 0 &&
      !p.endsWith('/') &&
      p.split('/').every((s) => s !== '.' && s !== '..' && !s.startsWith('.')) &&
      // eslint-disable-next-line no-control-regex
      !/[\u0000-\u001f]/.test(p),
    'Use a relative path like "folder/file.md", with no hidden or ".." parts',
  )

export const DocumentKind = z.enum([
  'library',
  'workspace_memory',
  'teammate_memory',
  'thread_summary',
])
export type DocumentKind = z.infer<typeof DocumentKind>

export const LibraryFile = z.object({
  id: z.string(),
  path: z.string(),
  contentType: z.string(),
  size: z.number().int(),
  /** Whether its text could be read for search. */
  indexed: z.boolean(),
  /** Whether it is plain text the dashboard can edit. */
  editable: z.boolean(),
  updatedAt: z.string(),
})
export type LibraryFile = z.infer<typeof LibraryFile>

export const MoveLibraryFile = z.object({ path: LibraryPath })
export const WriteLibraryText = z.object({ text: z.string().max(5_000_000) })
export const CreateLibraryText = z.object({ path: LibraryPath, text: z.string().max(5_000_000) })
export const WriteMemory = z.object({ text: z.string().max(MEMORY_MAX) })

export const MemoryFile = z.object({
  kind: DocumentKind,
  text: z.string(),
  updatedAt: z.string().nullable(),
})
export type MemoryFile = z.infer<typeof MemoryFile>

export const ThreadSummary = z.object({
  sessionId: z.string(),
  title: z.string(),
  teammateId: z.string().nullable(),
  text: z.string(),
  updatedAt: z.string(),
})
export type ThreadSummary = z.infer<typeof ThreadSummary>

export const MemoryOverview = z.object({
  workspace: MemoryFile,
  teammates: z.array(z.object({ teammateId: z.string(), name: z.string(), memory: MemoryFile })),
  summaries: z.array(ThreadSummary),
})
export type MemoryOverview = z.infer<typeof MemoryOverview>

export const SearchHit = z.object({
  kind: DocumentKind,
  /** Library path, or the memory file's name. */
  path: z.string(),
  /** The library file, or the thread of a summary. */
  documentId: z.string(),
  sessionId: z.string().nullable(),
  title: z.string(),
  /** Matching text, with matches between « and ». */
  snippet: z.string(),
})
export type SearchHit = z.infer<typeof SearchHit>

/** Lines to add to and remove from a memory file. Applied by the API, so edits never collide. */
export const MemoryEdit = z.object({
  add: z.array(z.string().trim().min(1).max(1000)).max(40).default([]),
  remove: z.array(z.string().trim().min(1).max(1000)).max(40).default([]),
})
export type MemoryEdit = z.infer<typeof MemoryEdit>

/** What the runner fetches to mirror the library and load memory. Never another workspace's. */
export const LibraryManifest = z.object({
  files: z.array(
    z.object({ id: z.string(), path: z.string(), sha256: z.string(), size: z.number() }),
  ),
  memory: z.object({
    workspace: z.string(),
    teammates: z.record(z.string(), z.string()),
  }),
})
export type LibraryManifest = z.infer<typeof LibraryManifest>

/** Largest text a file panel shows; longer files are cut. */
export const FILE_VIEW_MAX = 1024 * 1024

/** Largest image a thread shows from a teammate's working folder. */
export const IMAGE_VIEW_MAX = 10 * 1024 * 1024

/** Image files a thread shows as pictures, by extension. */
export const IMAGE_FILE = /\.(png|jpe?g|gif|webp)$/i

/** A file a thread mentions, for the panel beside it: from the library, or from a teammate's working folder. */
export const ThreadFile = z.object({
  source: z.enum(['library', 'thread']),
  /** The library path, or the path on the computer. */
  path: z.string(),
  /** Set for a library file. */
  documentId: z.string().optional(),
  contentType: z.string(),
  size: z.number().int(),
  /** Unset for a binary file. */
  text: z.string().optional(),
  truncated: z.boolean().default(false),
  /** Whose working folder it is in. */
  teammateId: z.string().optional(),
})
export type ThreadFile = z.infer<typeof ThreadFile>
