// The document library and memory (spec, "Memory and document library").
// Library files: bytes in the bucket, metadata and text in `Document`. Memory
// files and thread summaries: Markdown text in `Document` only. One search,
// PostgreSQL full text over all of them.
import { createHash } from 'node:crypto'
import { extname } from 'node:path'
import {
  LIBRARY_FILE_MAX,
  LIBRARY_VIEWS_PROTOCOL,
  libraryAccessFor,
  MEMORY_MAX,
  type LibraryFile,
  type LibraryManifest,
  type MemoryEdit,
  type SearchHit,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { audit, type Actor } from './audit.js'
import { documentKey, getObject, putObject } from './bucket.js'
import { notifyCollab } from './collab.js'
import { prisma, Prisma, scoped, type Scope, type ScopedDb } from './db.js'
import { notifyLibraryChanged } from './hub.js'
import { folderRules, teammateLibraryAccess } from './library-folders.js'
import { actorNames, ensureFirstVersion, recordVersion } from './library-history.js'
import { DOCX, officeText, PPTX, XLSX } from './previews.js'

/** Text kept for search per file; PostgreSQL's tsvector has a 1 MB limit. */
const INDEX_CHARS = 400_000
/** Text files up to this size can be edited in the dashboard. */
const EDITABLE_BYTES = 2 * 1024 * 1024

const TEXT_TYPES: Record<string, string> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.ts': 'text/plain',
  '.tsx': 'text/plain',
  '.py': 'text/x-python',
  '.sh': 'text/x-shellscript',
  '.sql': 'text/plain',
  '.toml': 'text/plain',
  '.ini': 'text/plain',
  '.log': 'text/plain',
}
const OTHER_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
  // Designs load these.
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.ico': 'image/x-icon',
}

/** The file's type, from its extension first: browsers often send none or a generic one. */
export function contentTypeFor(path: string, given?: string | null) {
  const ext = extname(path).toLowerCase()
  const known = TEXT_TYPES[ext] ?? OTHER_TYPES[ext]
  if (known) return known
  const type = given?.split(';')[0]?.trim().toLowerCase()
  return type && /^[a-z]+\/[a-z0-9.+-]+$/.test(type) ? type : 'application/octet-stream'
}

export const isText = (contentType: string) =>
  contentType.startsWith('text/') ||
  ['application/json', 'application/yaml', 'application/xml'].includes(contentType)

/** The text to index, or '' when the file has none Brigade can read (images, audio, video). */
export async function extractText(bytes: Uint8Array, contentType: string) {
  // PostgreSQL text cannot hold NUL, which PDFs (and some text files) put in their text.
  const storable = (text: string) => text.replace(/\u0000/g, '').slice(0, INDEX_CHARS)
  try {
    if (isText(contentType))
      return storable(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (contentType === 'application/pdf') {
      const { extractText: pdfText, getDocumentProxy } = await import('unpdf')
      const pdf = await getDocumentProxy(new Uint8Array(bytes))
      const { text } = await pdfText(pdf, { mergePages: true })
      return storable(text)
    }
    if ([DOCX, XLSX, PPTX].includes(contentType))
      return storable(await officeText(bytes, contentType))
  } catch {
    // Not valid UTF-8, or a damaged PDF: kept, just not searchable.
  }
  return ''
}

const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')

type DocumentRow = {
  id: string
  path: string
  contentType: string
  size: number
  indexed: boolean
  updatedAt: Date
  createdAt: Date
  createdByType: string | null
  createdById: string | null
  updatedByType: string | null
  updatedById: string | null
  updatedInSessionId: string | null
}

/** Library files as the dashboard lists them, with who made and changed each. */
export async function libraryFiles(db: ScopedDb, rows: DocumentRow[]): Promise<LibraryFile[]> {
  const who = await actorNames(
    db,
    rows.flatMap((r) => [
      { type: r.createdByType ?? '', id: r.createdById ?? '' },
      { type: r.updatedByType ?? '', id: r.updatedById ?? '' },
    ]),
  )
  return rows.map((row) => ({
    id: row.id,
    path: row.path,
    contentType: row.contentType,
    size: row.size,
    indexed: row.indexed,
    editable: isEditable(row),
    updatedAt: row.updatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    createdBy: who(row.createdByType, row.createdById),
    updatedBy: who(row.updatedByType, row.updatedById, row.updatedInSessionId),
  }))
}

export const libraryFileOf = async (db: ScopedDb, row: DocumentRow) =>
  (await libraryFiles(db, [row]))[0]!

export const isEditable = (row: { contentType: string; size: number }) =>
  isText(row.contentType) && row.size <= EDITABLE_BYTES

/** A document the dashboard edits as rich text: Markdown files and memory. */
export const isMarkdown = (row: { kind?: string; contentType: string; size: number }) =>
  row.kind !== 'thread_summary' && row.contentType === 'text/markdown' && row.size <= EDITABLE_BYTES

/** A document's whole text: a library file's bytes (its `text` is cut for search), or memory. */
export async function documentText(scope: Scope, row: { id: string; kind: string; text: string }) {
  if (row.kind !== 'library') return row.text
  return new TextDecoder().decode(await readLibraryFile(scope, row.id))
}

/**
 * Create a library file, or replace the one at that path. Every save that
 * changes it leaves a version, credited to the actor (and its thread).
 */
export async function saveLibraryFile(
  db: ScopedDb,
  scope: Scope,
  actor: Actor,
  input: { path: string; bytes: Uint8Array; contentType?: string | null },
  /** Recorded with the change, e.g. the thread a teammate saved it from (`sessionId`). */
  context: Record<string, string> = {},
  options: {
    /** Set when the collab server saves what people edited: its room already has it. */
    fromCollab?: boolean
    /** Set when the save brings back an older version. */
    restoredFromId?: string
  } = {},
) {
  if (input.bytes.byteLength > LIBRARY_FILE_MAX)
    throw new HTTPException(413, { message: 'Files in the library can be up to 25 MB' })
  const contentType = contentTypeFor(input.path, input.contentType)
  const hash = sha256(input.bytes)
  const existing = await db.document.findFirst({
    where: { kind: 'library', path: input.path, deletedAt: null },
  })
  // The same bytes again: nothing changed, nothing to record.
  if (
    existing &&
    existing.sha256 === hash &&
    existing.contentType === contentType &&
    !options.restoredFromId
  )
    return existing
  const text = await extractText(input.bytes, contentType)
  const sessionId = context.sessionId ?? null
  const fields = {
    contentType,
    size: input.bytes.byteLength,
    sha256: hash,
    text,
    indexed: text.trim().length > 0,
    updatedByType: actor.type,
    updatedById: actor.id,
    updatedInSessionId: sessionId,
  }
  let row
  if (existing) {
    // A file from before versions keeps what it was as its first.
    await ensureFirstVersion(db, scope, existing)
    await putObject(documentKey(scope, existing.id), input.bytes, contentType)
    row = await db.document.update({ where: { id: existing.id }, data: fields })
  } else {
    row = await db.document.create({
      data: {
        kind: 'library',
        path: input.path,
        ...fields,
        createdByType: actor.type,
        createdById: actor.id,
      } as never,
    })
    await putObject(documentKey(scope, row.id), input.bytes, contentType).catch(async (error) => {
      await db.document.delete({ where: { id: row!.id } })
      throw error
    })
  }
  await recordVersion(db, scope, row, input.bytes, actor, {
    sessionId,
    ...(options.restoredFromId ? { restoredFromId: options.restoredFromId } : {}),
  }).catch((error) => console.warn(`library: no version kept of ${row.id}: ${String(error)}`))
  await audit({
    ...scope,
    actor,
    action: existing ? 'library.file_replaced' : 'library.file_added',
    target: { type: 'document', id: row.id },
    data: { path: row.path, size: row.size, ...context },
  })
  notifyLibraryChanged(scope.workspaceId)
  if (existing && !options.fromCollab && isMarkdown(row)) notifyCollab(row.id)
  return row
}

export async function libraryFile(db: ScopedDb, id: string) {
  const row = await db.document.findFirst({ where: { id, kind: 'library', deletedAt: null } })
  if (!row) throw new HTTPException(404, { message: 'File not found' })
  return row
}

export async function readLibraryFile(scope: Scope, id: string) {
  const bytes = await getObject(documentKey(scope, id))
  if (!bytes) throw new HTTPException(404, { message: 'The file is missing from storage' })
  return bytes
}

export async function moveLibraryFile(
  db: ScopedDb,
  scope: Scope,
  actor: Actor,
  id: string,
  path: string,
) {
  const row = await libraryFile(db, id)
  if (row.path === path) return row
  if (await db.document.findFirst({ where: { kind: 'library', path } }))
    throw new HTTPException(409, { message: 'A file already has that path' })
  const moved = await db.document.update({
    where: { id },
    data: { path, contentType: contentTypeFor(path, row.contentType) },
  })
  await audit({
    ...scope,
    actor,
    action: 'library.file_moved',
    target: { type: 'document', id },
    data: { from: row.path, to: path },
  })
  notifyLibraryChanged(scope.workspaceId)
  return moved
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

type MemoryTarget = { kind: 'workspace_memory' } | { kind: 'teammate_memory'; teammateId: string }

const memoryPath = (target: MemoryTarget) =>
  target.kind === 'workspace_memory' ? 'workspace.md' : `teammates/${target.teammateId}.md`

/** A new memory file: just its heading. The dashboard says what it is for. */
export function memoryHeader(target: MemoryTarget, teammateName?: string) {
  return target.kind === 'workspace_memory'
    ? '# Workspace memory\n'
    : `# What ${teammateName ?? 'this teammate'} has learned\n`
}

export async function readMemory(db: ScopedDb, target: MemoryTarget) {
  return db.document.findFirst({ where: { kind: target.kind, path: memoryPath(target) } })
}

/** The memory file, created with just its heading if nothing was remembered yet. */
export async function ensureMemory(
  db: ScopedDb,
  scope: Scope,
  target: MemoryTarget,
  teammateName?: string,
) {
  return (
    (await readMemory(db, target)) ??
    upsertText(db, scope, target.kind, memoryPath(target), memoryHeader(target, teammateName), {
      ...(target.kind === 'teammate_memory' ? { teammateId: target.teammateId } : {}),
    })
  )
}

/** Which memory file a document row is. */
export function memoryTarget(row: { kind: string; teammateId: string | null }): MemoryTarget {
  if (row.kind === 'workspace_memory') return { kind: 'workspace_memory' }
  if (row.kind === 'teammate_memory' && row.teammateId)
    return { kind: 'teammate_memory', teammateId: row.teammateId }
  throw new HTTPException(400, { message: 'Not a memory file' })
}

/**
 * Save a Markdown document's new text, as a library file or memory. From the
 * dashboard's editor, directly or through the collab server.
 */
export async function saveDocumentText(
  db: ScopedDb,
  scope: Scope,
  actor: Actor,
  row: { id: string; kind: string; path: string; contentType: string; teammateId: string | null },
  text: string,
  options: { fromCollab?: boolean } = {},
) {
  if (row.kind === 'library')
    return saveLibraryFile(
      db,
      scope,
      actor,
      { path: row.path, bytes: new TextEncoder().encode(text), contentType: row.contentType },
      {},
      options,
    )
  if (text.length > MEMORY_MAX)
    throw new HTTPException(413, {
      message: `Memory files can be up to ${MEMORY_MAX.toLocaleString('en')} characters`,
    })
  return writeMemory(db, scope, actor, memoryTarget(row), text, options)
}

/** Replace a memory file's text (a person correcting it). */
export async function writeMemory(
  db: ScopedDb,
  scope: Scope,
  actor: Actor,
  target: MemoryTarget,
  text: string,
  /** Set when the collab server saves what people edited: its room already has it. */
  options: { fromCollab?: boolean } = {},
) {
  const row = await upsertText(db, scope, target.kind, memoryPath(target), text, {
    ...(target.kind === 'teammate_memory' ? { teammateId: target.teammateId } : {}),
  })
  await audit({
    ...scope,
    actor,
    action: 'memory.written',
    target: { type: 'document', id: row.id },
    data: {
      kind: target.kind,
      ...(target.kind === 'teammate_memory' ? { teammateId: target.teammateId } : {}),
    },
  })
  notifyLibraryChanged(scope.workspaceId)
  if (!options.fromCollab) notifyCollab(row.id)
  return row
}

const normalize = (line: string) =>
  line
    .replace(/^\s*[-*+]\s+/, '')
    .trim()
    .toLowerCase()

/**
 * Remove the lines a thread found wrong and add what it learned, keeping
 * everything else, people's edits included. Applied here so that two threads
 * ending together never overwrite each other.
 */
export function applyMemoryEdit(text: string, edit: MemoryEdit) {
  const remove = new Set(edit.remove.map(normalize))
  const lines = text.split('\n').filter((l) => !l.trim() || !remove.has(normalize(l)))
  const removed = text.split('\n').length - lines.length
  const present = new Set(lines.map(normalize))
  let out = lines.join('\n').replace(/\n*$/, '\n')
  const lastLine = lines.findLast((l) => l.trim()) ?? ''
  let added = 0
  for (const line of edit.add) {
    const key = normalize(line)
    if (present.has(key)) continue
    const bullet = `- ${line.replace(/^\s*[-*+]\s+/, '').replace(/\s*\n\s*/g, ' ')}\n`
    // A list after a paragraph needs a blank line before it.
    const gap = added === 0 && !/^\s*[-*+]\s/.test(lastLine) && !out.endsWith('\n\n') ? '\n' : ''
    if (out.length + gap.length + bullet.length > MEMORY_MAX) break
    out += gap + bullet
    present.add(key)
    added++
  }
  return { text: out, added, removed }
}

/** Apply a thread's edit to a memory file, creating it on first use. */
export async function editMemory(
  db: ScopedDb,
  scope: Scope,
  actor: Actor,
  target: MemoryTarget & { teammateName?: string },
  edit: MemoryEdit,
  sessionId: string,
) {
  if (edit.add.length === 0 && edit.remove.length === 0) return
  // One edit at a time per file, so concurrent threads both land.
  const row = await prisma.$transaction(async (tx) => {
    const path = memoryPath(target)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${scope.workspaceId}:${path}`}))`
    const current = await tx.document.findFirst({
      where: { ...scope, kind: target.kind, path },
    })
    const result = applyMemoryEdit(current?.text ?? memoryHeader(target, target.teammateName), edit)
    if (result.added === 0 && result.removed === 0) return
    const fields = {
      text: result.text,
      size: Buffer.byteLength(result.text),
      sha256: sha256(result.text),
      indexed: true,
    }
    const row = current
      ? await tx.document.update({ where: { id: current.id }, data: fields })
      : await tx.document.create({
          data: {
            ...scope,
            kind: target.kind,
            path,
            contentType: 'text/markdown',
            ...(target.kind === 'teammate_memory' ? { teammateId: target.teammateId } : {}),
            ...fields,
          },
        })
    await tx.auditEntry.create({
      data: {
        ...scope,
        actorType: actor.type,
        actorId: actor.id,
        action: 'memory.updated',
        targetType: 'document',
        targetId: row.id,
        data: { kind: target.kind, sessionId, added: result.added, removed: result.removed },
      },
    })
    return row
  })
  // Merged into what people may be editing, line by line as the thread asked.
  if (row) notifyCollab(row.id)
  return row
}

/** The thread's summary: replaced each time the thread goes quiet. */
export async function saveSummary(
  db: ScopedDb,
  scope: Scope,
  session: { id: string; title: string; teammateId: string },
  summary: string,
) {
  return upsertText(
    db,
    scope,
    'thread_summary',
    `threads/${session.id}.md`,
    `# ${session.title}\n\n${summary}\n`,
    {
      sessionId: session.id,
      teammateId: session.teammateId,
    },
  )
}

async function upsertText(
  db: ScopedDb,
  scope: Scope,
  kind: 'workspace_memory' | 'teammate_memory' | 'thread_summary',
  path: string,
  text: string,
  links: { teammateId?: string; sessionId?: string },
) {
  const fields = {
    text,
    size: Buffer.byteLength(text),
    sha256: sha256(text),
    indexed: true,
  }
  return db.document.upsert({
    where: { workspaceId_kind_path: { workspaceId: scope.workspaceId, kind, path } },
    create: { kind, path, contentType: 'text/markdown', ...links, ...fields } as never,
    update: fields,
  })
}

// ---------------------------------------------------------------------------
// Search and sync
// ---------------------------------------------------------------------------

/**
 * Full-text search over the library, memory and past thread summaries. A
 * teammate sees its own memory only; nobody sees a private thread's summary
 * except the member who started it.
 */
export async function search(
  scope: Scope,
  input: {
    query: string
    limit: number
    /** A teammate searching: its own memory only, and the folders it may read. */
    teammate?: { id: string; libraryAccess: 'read' | 'read_write' }
    memberId?: string
  },
): Promise<SearchHit[]> {
  const access = input.teammate
    ? await teammateLibraryAccess(scoped(scope), input.teammate)
    : undefined
  // Hits from folders the teammate cannot see are dropped after ranking: ask for more.
  const limit = access?.rules.length ? input.limit + 40 : input.limit
  const ownMemory = input.teammate
    ? Prisma.sql`AND (d.kind <> 'teammate_memory' OR d."teammateId" = ${input.teammate.id})`
    : Prisma.empty
  const summaries = input.memberId
    ? Prisma.sql`AND (d.kind <> 'thread_summary' OR s.private = false OR s."startedByMemberId" = ${input.memberId})`
    : Prisma.sql`AND (d.kind <> 'thread_summary' OR s.private = false)`
  const rows = await prisma.$queryRaw<
    {
      id: string
      kind: SearchHit['kind']
      path: string
      sessionId: string | null
      teammateName: string | null
      title: string | null
      snippet: string
    }[]
  >`
    WITH q AS (
      SELECT websearch_to_tsquery('english', ${input.query}) || websearch_to_tsquery('simple', ${input.query}) AS query
    )
    SELECT d.id, d.kind, d.path, d."sessionId", t.name AS "teammateName", s.title,
      ts_headline('english', left(d.text, 100000), q.query,
        'StartSel=«, StopSel=», MaxFragments=2, MaxWords=35, MinWords=12, FragmentDelimiter=" … "') AS snippet
    FROM "Document" d
    CROSS JOIN q
    LEFT JOIN "Session" s ON s.id = d."sessionId"
    LEFT JOIN "Teammate" t ON t.id = d."teammateId"
    WHERE d."organizationId" = ${scope.organizationId}
      AND d."workspaceId" = ${scope.workspaceId}
      AND d.search @@ q.query
      AND d."deletedAt" IS NULL
      ${ownMemory}
      ${summaries}
    ORDER BY ts_rank(d.search, q.query) DESC, d."updatedAt" DESC
    LIMIT ${limit}`
  return rows
    .filter((r) => r.kind !== 'library' || !access || access.of(r.path) !== 'none')
    .slice(0, input.limit)
    .map((r) => ({
      kind: r.kind,
      path: r.path,
      documentId: r.id,
      sessionId: r.sessionId,
      title:
        r.kind === 'library'
          ? r.path
          : r.kind === 'workspace_memory'
            ? 'Workspace memory'
            : r.kind === 'teammate_memory'
              ? `${r.teammateName ?? 'A teammate'}'s memory`
              : `Thread: ${r.title ?? r.sessionId}`,
      snippet: r.snippet,
    }))
}

/**
 * What a computer mirrors: the library files, who may read which, and the
 * memory each teammate loads. A runner too old to keep a mirror per teammate
 * gets only the files every teammate may read.
 */
export async function manifest(
  db: ScopedDb,
  runner: { protocolVersion: number | null },
): Promise<LibraryManifest> {
  const [files, memory, teammates, folders] = await Promise.all([
    db.document.findMany({
      where: { kind: 'library', deletedAt: null },
      select: { id: true, path: true, sha256: true, size: true },
      orderBy: { path: 'asc' },
    }),
    db.document.findMany({
      where: { kind: { in: ['workspace_memory', 'teammate_memory'] } },
      select: { kind: true, teammateId: true, text: true },
    }),
    db.teammate.findMany({
      where: { archivedAt: null },
      select: { id: true, libraryAccess: true },
    }),
    folderRules(db),
  ])
  const access = {
    teammates: teammates.map((t) => ({ id: t.id, library: t.libraryAccess })),
    folders,
  }
  const shared = (path: string) =>
    access.teammates.every((t) => libraryAccessFor(path, t, folders) !== 'none')
  return {
    files:
      (runner.protocolVersion ?? 0) >= LIBRARY_VIEWS_PROTOCOL
        ? files
        : files.filter((f) => shared(f.path)),
    memory: {
      workspace: memory.find((m) => m.kind === 'workspace_memory')?.text ?? '',
      teammates: Object.fromEntries(
        memory
          .filter((m) => m.kind === 'teammate_memory' && m.teammateId)
          .map((m) => [m.teammateId!, m.text]),
      ),
    },
    access,
  }
}
