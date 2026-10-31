// The document library and memory: files in one shared folder per workspace,
// Markdown memory at three levels, and one search over both.
import { z } from 'zod'

/**
 * Largest file the library takes, from a member or a teammate: straight to the bucket, never
 * read whole by the API. As large as a member's upload to a thread (UPLOAD_FILE_MAX).
 */
export const LIBRARY_FILE_MAX = 500 * 1024 * 1024
/**
 * Largest library file the API reads whole: to preview an Office file, to restore a version
 * through it, or saved by a runner from before direct uploads (in its message). Larger ones are
 * copied inside the bucket and served from it.
 */
export const LIBRARY_READ_MAX = 25 * 1024 * 1024
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
  /** The files this member pinned, by id, in the order they pinned them. */
  pinned: z.array(z.string()),
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
/** A file uploaded straight to the bucket (POST /api/uploads), saved at a path. */
export const SaveLibraryUpload = z.object({
  path: LibraryPath,
  uploadId: z.string().min(1).max(64),
})
export const WriteMemory = z.object({ text: z.string().max(MEMORY_MAX) })

/** Where a memory line came from, as the dashboard shows it. */
export const MemoryLineInfo = z.object({
  /** When it was learned, or last confirmed by a thread. */
  at: z.string(),
  /** It was there before memory kept dates: learned before `at`. */
  legacy: z.boolean().default(false),
  /** The person who wrote it in the editor; null when a teammate learned it. */
  by: z.string().nullable().default(null),
  /** The thread it was learned in. */
  sessionId: z.string().nullable().default(null),
  threadTitle: z.string().nullable().default(null),
})
export type MemoryLineInfo = z.infer<typeof MemoryLineInfo>

export const MemoryFile = z.object({
  kind: DocumentKind,
  text: z.string(),
  updatedAt: z.string().nullable(),
  /** The memory file's document; null until something is remembered. */
  documentId: z.string().nullable().default(null),
  /** Each line's date and source, by its key (memoryLineKey). */
  lines: z.record(z.string(), MemoryLineInfo).default({}),
  /** Lines that left the file and can be put back. */
  archived: z.number().int().default(0),
})
export type MemoryFile = z.infer<typeof MemoryFile>

/** A line that left a memory file: replaced, merged, outdated, or removed by a person. */
export const ArchivedMemoryLine = z.object({
  id: z.string(),
  text: z.string(),
  /** The topic it was under; null for the core. */
  topic: z.string().nullable(),
  reason: z.string(),
  archivedAt: z.string(),
  /** Who took it out: a person's or a teammate's name. */
  archivedBy: z.string().nullable(),
  /** When it was learned, and in which thread. */
  createdAt: z.string(),
  sessionId: z.string().nullable(),
  threadTitle: z.string().nullable(),
})
export type ArchivedMemoryLine = z.infer<typeof ArchivedMemoryLine>

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
  projects: z
    .array(z.object({ projectId: z.string(), name: z.string(), memory: MemoryFile }))
    .default([]),
  summaries: z.array(ThreadSummary),
})
export type MemoryOverview = z.infer<typeof MemoryOverview>

export const SearchHit = z.object({
  /** archived_memory: a line that left a memory file, with why. */
  kind: z.union([DocumentKind, z.literal('archived_memory')]),
  /** Library path, or the memory file's name. */
  path: z.string(),
  /** The library file, the memory file, or the thread of a summary. */
  documentId: z.string(),
  sessionId: z.string().nullable(),
  title: z.string(),
  /** Matching text, with matches between « and ». */
  snippet: z.string(),
})
export type SearchHit = z.infer<typeof SearchHit>

/** A new line, as a thread writes it. */
const MemoryText = z.string().trim().min(1).max(1000)
/** A line already in a file, which people may have written longer. */
const MemoryRef = z.string().trim().min(1).max(MEMORY_MAX)

/**
 * What a thread changes in a memory file. Applied by the API, so edits never
 * collide. Lines are named by their text. `add` and `remove` are what runners
 * before protocol 35 send: lines added to the core, lines removed.
 */
export const MemoryEdit = z.object({
  add: z.array(MemoryText).max(40).default([]),
  remove: z.array(MemoryText).max(40).default([]),
  /** New lines, each under its topic (null: the core, which every thread loads). */
  lines: z
    .array(
      z.object({ text: MemoryText, topic: z.string().trim().max(60).nullable().default(null) }),
    )
    .max(40)
    .default([]),
  /** Lines said again, corrected: the old one goes to the archive. */
  replace: z
    .array(z.object({ from: MemoryRef, to: MemoryText }))
    .max(40)
    .default([]),
  /** Lines that go to the archive, with why. */
  archive: z
    .array(z.object({ text: MemoryRef, reason: z.string().trim().max(200) }))
    .max(40)
    .default([]),
  /** Lines the thread found still true: their date moves to now. */
  confirm: z.array(MemoryRef).max(60).default([]),
})
export type MemoryEdit = z.infer<typeof MemoryEdit>
/** A thread's edit as changes to a memory file's text (changeMemoryFile), the same on the runner and the API. */
export const memoryEditChanges = (edit: MemoryEdit) => ({
  remove: [...edit.remove, ...edit.archive.map((a) => a.text)],
  replace: edit.replace,
  add: [...edit.add.map((text) => ({ text, topic: null })), ...edit.lines],
})

export const NO_MEMORY_EDIT: MemoryEdit = {
  add: [],
  remove: [],
  lines: [],
  replace: [],
  archive: [],
  confirm: [],
}

/** When a line was learned or last confirmed, as a runner shows it to a teammate. */
export const MemoryLineMeta = z.object({
  at: z.string(),
  /** The person who wrote it, when a person did. */
  by: z.string().optional(),
  /** There before memory kept dates: learned before `at`. */
  legacy: z.boolean().optional(),
})
export type MemoryLineMeta = z.infer<typeof MemoryLineMeta>

/** A memory file, as a runner names it to the API. */
export const MemoryFileRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workspace') }),
  z.object({ kind: z.literal('project'), projectId: z.string() }),
  z.object({ kind: z.literal('teammate'), teammateId: z.string() }),
])
export type MemoryFileRef = z.infer<typeof MemoryFileRef>

/** A memory file's path among the documents: workspace.md, projects/<id>.md, teammates/<id>.md. */
export const memoryFilePath = (ref: MemoryFileRef) =>
  ref.kind === 'workspace'
    ? 'workspace.md'
    : ref.kind === 'project'
      ? `projects/${ref.projectId}.md`
      : `teammates/${ref.teammateId}.md`

/** What the runner fetches to mirror the library and load memory. Never another workspace's. */
export const LibraryManifest = z.object({
  files: z.array(
    z.object({ id: z.string(), path: z.string(), sha256: z.string(), size: z.number() }),
  ),
  memory: z.object({
    workspace: z.string(),
    teammates: z.record(z.string(), z.string()),
    /** Projects' memory, by project: fresher than a thread's spec, for the runs that edit it. */
    projects: z.record(z.string(), z.string()).optional(),
    /** Each line's date, by memory file path (memoryFilePath) and line key (memoryLineKey). */
    lines: z.record(z.string(), z.record(z.string(), MemoryLineMeta)).optional(),
    /** When each memory file was last tidied, by path. */
    tidied: z.record(z.string(), z.string()).optional(),
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
  /** To read, not edit: a viewer's (no live, no save). */
  readOnly: z.boolean().optional(),
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
  /**
   * The SHA-256 of a whole text file in a teammate's working folder, from runners that
   * write files (CODE_EDIT_PROTOCOL): it can be edited, and a save names it to catch
   * a change made since it was opened.
   */
  hash: z.string().optional(),
})
export type ThreadFile = z.infer<typeof ThreadFile>

/** A person saves a text file of a teammate's working folder, as read with its `hash`. */
export const SaveThreadFile = z.object({
  path: z.string().min(1).max(1000),
  teammateId: z.string().min(1),
  text: z.string().max(FILE_VIEW_MAX),
  /** The hash it was opened at; unset to write over whatever is there. */
  base: z.string().optional(),
})
export type SaveThreadFile = z.infer<typeof SaveThreadFile>

/** A saved file's new hash. A file changed since it was opened answers 409 instead. */
export const SavedThreadFile = z.object({
  hash: z.string(),
})
export type SavedThreadFile = z.infer<typeof SavedThreadFile>

/** Where an element of a thread's preview is written, found by its text. */
export const FindSource = z.object({
  teammateId: z.string().min(1),
  /** The preview's folder, relative to the teammate's working folder. */
  cwd: z.string().max(500),
  text: z.string().min(1).max(500),
  /** React components around it, outermost first: files named after them come first. */
  components: z.array(z.string().max(100)).max(8).optional(),
})
export type FindSource = z.infer<typeof FindSource>

export const SourceMatch = z.object({
  /** Relative to the teammate's working folder. */
  path: z.string(),
  line: z.number().int().positive(),
  /** The line, trimmed and clipped. */
  preview: z.string(),
})
export type SourceMatch = z.infer<typeof SourceMatch>

/** An entry of a folder of a teammate's working folder, for the code panel's tree. */
export const CodeEntry = z.object({
  name: z.string(),
  dir: z.boolean(),
})
export type CodeEntry = z.infer<typeof CodeEntry>

/** Most entries a folder lists in the tree; past it, `more`. */
export const CODE_LIST_MAX = 2000
/** Most files a tree's filter or search answers with. */
export const CODE_FIND_MAX = 50
/** Most open files whose hashes one request asks for. */
export const CODE_HASHES_MAX = 20

/** Most changed files the code panel's Changes list shows; past it, `more`. */
export const CODE_CHANGES_MAX = 500

/**
 * A file of a teammate's working folder that differs from where its repository's
 * branch left its default branch, or from its last commit: modified, new (added or
 * not yet tracked) or deleted.
 */
export const CodeChange = z.object({
  /** Relative to the teammate's working folder. */
  path: z.string(),
  status: z.enum(['M', 'A', 'D']),
  /** The default branch its repository compares to ("main"); unset: its last commit. */
  base: z.string().optional(),
})
export type CodeChange = z.infer<typeof CodeChange>

/** Files to put back as changes compares them to: new ones are deleted. */
export const RevertCode = z.object({
  teammateId: z.string().min(1),
  paths: z.array(z.string().min(1).max(1000)).min(1).max(CODE_CHANGES_MAX),
})
export type RevertCode = z.infer<typeof RevertCode>

/** The hashes of open files, to see when one changed on the computer. */
export const CodeHashes = z.object({
  teammateId: z.string().min(1),
  paths: z.array(z.string().min(1).max(1000)).min(1).max(CODE_HASHES_MAX),
})
export type CodeHashes = z.infer<typeof CodeHashes>
