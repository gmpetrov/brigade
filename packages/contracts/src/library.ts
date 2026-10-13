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
  'project_memory',
])
export type DocumentKind = z.infer<typeof DocumentKind>

/** Who did something to a library file: a person, a teammate (from a thread), or Brigade. */
export const LibraryActor = z.object({
  type: z.enum(['member', 'teammate', 'runner', 'system']),
  id: z.string(),
  /** The person's or teammate's name; "Brigade" for the system. */
  name: z.string(),
  /** The thread a teammate did it from. */
  sessionId: z.string().nullable().default(null),
})
export type LibraryActor = z.infer<typeof LibraryActor>

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
  createdAt: z.string(),
  /** Unknown for files from before this was kept. */
  createdBy: LibraryActor.nullable(),
  updatedBy: LibraryActor.nullable(),
})
export type LibraryFile = z.infer<typeof LibraryFile>

/** Days a file stays in the trash before it is deleted for good. */
export const TRASH_DAYS = 30

export const TrashedFile = z.object({
  id: z.string(),
  /** Where it was, and where a restore puts it back. */
  path: z.string(),
  contentType: z.string(),
  size: z.number().int(),
  deletedAt: z.string(),
  deletedBy: LibraryActor.nullable(),
  /** When it is deleted for good. */
  purgeAt: z.string(),
})
export type TrashedFile = z.infer<typeof TrashedFile>

export const LibraryVersion = z.object({
  id: z.string(),
  path: z.string(),
  contentType: z.string(),
  size: z.number().int(),
  sha256: z.string(),
  by: LibraryActor,
  /** Set when this version brought back an older one. */
  restoredFromId: z.string().nullable(),
  createdAt: z.string(),
  /** Later than createdAt when saves were folded into it. */
  updatedAt: z.string(),
  /** The file as it is now. */
  current: z.boolean(),
})
export type LibraryVersion = z.infer<typeof LibraryVersion>

/** Versions kept per file; older ones are deleted. */
export const VERSIONS_KEPT = 50

/** What a teammate may do in a folder: nothing (it does not see it), read, or also save. */
export const FolderAccess = z.enum(['none', 'read', 'read_write'])
export type FolderAccess = z.infer<typeof FolderAccess>

export const LibraryFolder = z.object({
  path: z.string(),
  /** Made by someone, or holding access rules; other folders exist through their files. */
  explicit: z.boolean(),
  /** Only teammates granted access here, or in a folder inside, reach it. */
  restricted: z.boolean(),
  grants: z.array(z.object({ teammateId: z.string(), access: LibraryAccess })),
})
export type LibraryFolder = z.infer<typeof LibraryFolder>

export const LibraryTree = z.object({
  files: z.array(LibraryFile),
  folders: z.array(LibraryFolder),
})
export type LibraryTree = z.infer<typeof LibraryTree>

export const CreateLibraryFolder = z.object({ path: LibraryPath })
export const MoveLibraryFolder = z.object({ path: LibraryPath, to: LibraryPath })
export const SetFolderAccess = z.object({
  path: LibraryPath,
  restricted: z.boolean(),
  grants: z
    .array(z.object({ teammateId: z.string(), access: LibraryAccess }))
    .max(200)
    .default([]),
})
export type SetFolderAccess = z.infer<typeof SetFolderAccess>

/** A folder's access rules, as the API, the runner and the dashboard read them. */
export type FolderRule = {
  path: string
  restricted: boolean
  /** Teammate id to its access there. */
  grants: Record<string, LibraryAccess>
}

/** Whether `path` is `folder` itself or inside it. */
export const inFolder = (path: string, folder: string) =>
  path === folder || path.startsWith(`${folder}/`)

/**
 * What a teammate may do with a library file: the grant of the deepest folder
 * holding it that has one for this teammate; nothing if a restricted folder
 * comes first; at the top, its default library access.
 */
export function libraryAccessFor(
  path: string,
  teammate: { id: string; library: LibraryAccess },
  folders: FolderRule[],
): FolderAccess {
  const holding = folders
    .filter((f) => path !== f.path && inFolder(path, f.path))
    .sort((a, b) => b.path.length - a.path.length)
  for (const folder of holding) {
    const grant = folder.grants[teammate.id]
    if (grant) return grant
    if (folder.restricted) return 'none'
  }
  return teammate.library
}

/** The same for what is directly in a folder. */
export const folderAccessFor = (
  folder: string,
  teammate: { id: string; library: LibraryAccess },
  folders: FolderRule[],
) => libraryAccessFor(`${folder}/*`, teammate, folders)

/**
 * The folders where a teammate's access differs from the folder holding them
 * (its default at the top): read-only, or open to saving. Folders it cannot
 * see are left out, names included.
 */
export function folderExceptions(
  teammate: { id: string; library: LibraryAccess },
  rules: FolderRule[],
): { path: string; access: 'read' | 'read_write' }[] {
  const out: { path: string; access: 'read' | 'read_write' }[] = []
  for (const rule of [...rules].sort((a, b) => a.path.localeCompare(b.path))) {
    const access = folderAccessFor(rule.path, teammate, rules)
    if (access === 'none') continue
    const parent = rule.path.includes('/')
      ? folderAccessFor(rule.path.slice(0, rule.path.lastIndexOf('/')), teammate, rules)
      : teammate.library
    if (access !== parent) out.push({ path: rule.path, access })
  }
  return out
}

/** A preview of a file the browser cannot show as itself, made by the API. */
export const LibraryPreview = z.discriminatedUnion('kind', [
  /** A Word document as HTML, shown in a sandboxed frame that runs no script. */
  z.object({ kind: z.literal('html'), html: z.string() }),
  z.object({
    kind: z.literal('sheets'),
    sheets: z.array(
      z.object({
        name: z.string(),
        rows: z.array(z.array(z.string())),
        /** Rows or columns were left out. */
        truncated: z.boolean(),
      }),
    ),
  }),
  z.object({
    kind: z.literal('slides'),
    slides: z.array(z.object({ title: z.string(), lines: z.array(z.string()) })),
  }),
  z.object({ kind: z.literal('none'), reason: z.string() }),
])
export type LibraryPreview = z.infer<typeof LibraryPreview>

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
  /**
   * Who may read what: each teammate's default access and the folders' rules.
   * The runner gives each teammate a mirror of only what it may read.
   */
  access: z
    .object({
      teammates: z.array(z.object({ id: z.string(), library: LibraryAccess })),
      folders: z.array(
        z.object({
          path: z.string(),
          restricted: z.boolean(),
          grants: z.record(z.string(), LibraryAccess),
        }),
      ),
    })
    .optional(),
})
export type LibraryManifest = z.infer<typeof LibraryManifest>

/** A document people edit in the dashboard: a Markdown library file, or a memory file. */
export const EditTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('library'), id: z.string() }),
  z.object({ kind: z.literal('workspace_memory') }),
  z.object({ kind: z.literal('teammate_memory'), teammateId: z.string() }),
  z.object({ kind: z.literal('project_memory'), projectId: z.string() }),
])
export type EditTarget = z.infer<typeof EditTarget>

/** The Yjs fragment a document's blocks live in, in the editor and on the collab server. */
export const DOCUMENT_FRAGMENT = 'document-store'

/**
 * Opening a document to edit. With `live`, the editor syncs through the collab
 * server; without it (no collab server configured), it saves `text` back with
 * PUT /api/library/edit/:documentId.
 */
export const EditSession = z.object({
  documentId: z.string(),
  text: z.string(),
  live: z
    .object({
      /** The collab server, e.g. https://collab.example.com. */
      url: z.string(),
      /** Its Durable Object class, as the URL names it. */
      party: z.string(),
      room: z.string(),
      /** Short-lived; ask again for a new one when reconnecting. */
      token: z.string(),
      user: z.object({ name: z.string(), color: z.string() }),
    })
    .nullable(),
})
export type EditSession = z.infer<typeof EditSession>

/** Largest file put in a document when the browser uploads straight to the bucket. */
export const ASSET_MAX = 100 * 1024 * 1024
/** ... and when it goes through the API (development, without R2). */
export const ASSET_MAX_THROUGH_API = 25 * 1024 * 1024

/** A file in a document: what the editor puts in its block. */
export const DocumentAsset = z.object({
  id: z.string(),
  /** `asset:<id>`, as the document refers to it. */
  url: z.string(),
  name: z.string(),
  contentType: z.string(),
  size: z.number().int(),
})
export type DocumentAsset = z.infer<typeof DocumentAsset>

export const StartAssetUpload = z.object({
  documentId: z.string(),
  name: z.string().trim().min(1).max(255),
  size: z.number().int().min(1).max(ASSET_MAX, 'Files in a document can be up to 100 MB'),
  contentType: z.string().max(255).default('application/octet-stream'),
})
export type StartAssetUpload = z.infer<typeof StartAssetUpload>

/**
 * How the browser sends a document's file: straight to the bucket (PUT the
 * bytes to `url`, then POST /api/library/assets/:id/complete), or through
 * the API (POST /api/library/assets, multipart `file` and `documentId`).
 */
export const AssetTicket = z.discriminatedUnion('direct', [
  z.object({ direct: z.literal(false) }),
  z.object({
    direct: z.literal(true),
    asset: DocumentAsset,
    url: z.string(),
    method: z.literal('PUT'),
    headers: z.record(z.string(), z.string()),
  }),
])
export type AssetTicket = z.infer<typeof AssetTicket>

/** Largest text a file panel shows; longer files are cut. */
export const FILE_VIEW_MAX = 1024 * 1024

/** Largest image or PDF a thread shows from a teammate's working folder. */
export const IMAGE_VIEW_MAX = 10 * 1024 * 1024

/** Image files a thread shows as pictures, by extension. */
export const IMAGE_FILE = /\.(png|jpe?g|gif|webp)$/i

/** Files the file panel shows as themselves, not as text: images and PDFs. */
export const VIEWABLE_FILE = /\.(png|jpe?g|gif|webp|pdf)$/i

/** A file a thread mentions, for the panel beside it: from the library, the thread's attachments, or a teammate's working folder. */
export const ThreadFile = z.object({
  source: z.enum(['library', 'thread', 'attachment']),
  /** The library path, or the path on the computer. */
  path: z.string(),
  /** Set for a library file. */
  documentId: z.string().optional(),
  /** Set for a file given to the thread: its original, as uploaded or received. */
  attachmentId: z.string().optional(),
  contentType: z.string(),
  size: z.number().int(),
  /** Unset for a binary file. */
  text: z.string().optional(),
  truncated: z.boolean().default(false),
  /** Whose working folder it is in. */
  teammateId: z.string().optional(),
})
export type ThreadFile = z.infer<typeof ThreadFile>
