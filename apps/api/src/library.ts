// The document library and memory (spec, "Memory and document library").
// Library files: bytes in the bucket, metadata and text in `Document`. Memory
// files and thread summaries: Markdown text in `Document` only. One search,
// PostgreSQL full text over all of them.
import { createHash } from 'node:crypto'
import { extname } from 'node:path'
import {
  LIBRARY_FILE_MAX,
  MEMORY_MAX,
  type LibraryFile,
  type LibraryManifest,
  type MemoryEdit,
  type SearchHit,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { audit, type Actor } from './audit.js'
import { deleteObject, documentKey, getObject, putObject } from './bucket.js'
import { prisma, Prisma, type Scope, type ScopedDb } from './db.js'
import { notifyLibraryChanged } from './hub.js'

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
  '.svg': 'image/svg+xml',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
}

/** The file's type, from its extension first: browsers often send none or a generic one. */
export function contentTypeFor(path: string, given?: string | null) {
  const ext = extname(path).toLowerCase()
  const known = TEXT_TYPES[ext] ?? OTHER_TYPES[ext]
  if (known) return known
  const type = given?.split(';')[0]?.trim().toLowerCase()
  return type && /^[a-z]+\/[a-z0-9.+-]+$/.test(type) ? type : 'application/octet-stream'
}

const isText = (contentType: string) =>
  contentType.startsWith('text/') ||
  ['application/json', 'application/yaml', 'application/xml'].includes(contentType)

/** The text to index, or '' when the file has none Brigade can read (images, office files). */
async function extractText(bytes: Uint8Array, contentType: string) {
  try {
    if (isText(contentType))
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes).slice(0, INDEX_CHARS)
    if (contentType === 'application/pdf') {
      const { extractText: pdfText, getDocumentProxy } = await import('unpdf')
      const pdf = await getDocumentProxy(new Uint8Array(bytes))
      const { text } = await pdfText(pdf, { mergePages: true })
      return text.slice(0, INDEX_CHARS)
    }
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
}

export const toLibraryFile = (row: DocumentRow): LibraryFile => ({
  id: row.id,
  path: row.path,
  contentType: row.contentType,
  size: row.size,
  indexed: row.indexed,
  editable: isText(row.contentType) && row.size <= EDITABLE_BYTES,
  updatedAt: row.updatedAt.toISOString(),
})

/** Create a library file, or replace the one at that path. */
export async function saveLibraryFile(
  db: ScopedDb,
  scope: Scope,
  actor: Actor,
  input: { path: string; bytes: Uint8Array; contentType?: string | null },
  /** Recorded with the change, e.g. the thread a teammate saved it from. */
  context: Record<string, string> = {},
) {
  if (input.bytes.byteLength > LIBRARY_FILE_MAX)
    throw new HTTPException(413, { message: 'Files in the library can be up to 25 MB' })
  const contentType = contentTypeFor(input.path, input.contentType)
  const text = await extractText(input.bytes, contentType)
  const fields = {
    contentType,
    size: input.bytes.byteLength,
    sha256: sha256(input.bytes),
    text,
    indexed: text.trim().length > 0,
  }
  const existing = await db.document.findFirst({ where: { kind: 'library', path: input.path } })
  let row
  if (existing) {
    await putObject(documentKey(scope, existing.id), input.bytes, contentType)
    row = await db.document.update({ where: { id: existing.id }, data: fields })
  } else {
    row = await db.document.create({
      data: { kind: 'library', path: input.path, ...fields } as never,
    })
    await putObject(documentKey(scope, row.id), input.bytes, contentType).catch(async (error) => {
      await db.document.delete({ where: { id: row!.id } })
      throw error
    })
  }
  await audit({
    ...scope,
    actor,
    action: existing ? 'library.file_replaced' : 'library.file_added',
    target: { type: 'document', id: row.id },
    data: { path: row.path, size: row.size, ...context },
  })
  notifyLibraryChanged(scope.workspaceId)
  return row
}

export async function libraryFile(db: ScopedDb, id: string) {
  const row = await db.document.findFirst({ where: { id, kind: 'library' } })
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

export async function deleteLibraryFile(db: ScopedDb, scope: Scope, actor: Actor, id: string) {
  const row = await libraryFile(db, id)
  await db.document.delete({ where: { id } })
  await deleteObject(documentKey(scope, id)).catch((error) =>
    console.warn(`library: could not delete ${id} from the bucket: ${String(error)}`),
  )
  await audit({
    ...scope,
    actor,
    action: 'library.file_deleted',
    target: { type: 'document', id },
    data: { path: row.path },
  })
  notifyLibraryChanged(scope.workspaceId)
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

/** Replace a memory file's text (a person correcting it). */
export async function writeMemory(
  db: ScopedDb,
  scope: Scope,
  actor: Actor,
  target: MemoryTarget,
  text: string,
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
  return prisma.$transaction(async (tx) => {
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
  input: { query: string; limit: number; teammateId?: string; memberId?: string },
): Promise<SearchHit[]> {
  const ownMemory = input.teammateId
    ? Prisma.sql`AND (d.kind <> 'teammate_memory' OR d."teammateId" = ${input.teammateId})`
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
      ${ownMemory}
      ${summaries}
    ORDER BY ts_rank(d.search, q.query) DESC, d."updatedAt" DESC
    LIMIT ${input.limit}`
  return rows.map((r) => ({
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

/** What a computer mirrors: every library file, and the memory each teammate loads. */
export async function manifest(db: ScopedDb): Promise<LibraryManifest> {
  const [files, memory] = await Promise.all([
    db.document.findMany({
      where: { kind: 'library' },
      select: { id: true, path: true, sha256: true, size: true },
      orderBy: { path: 'asc' },
    }),
    db.document.findMany({
      where: { kind: { in: ['workspace_memory', 'teammate_memory'] } },
      select: { kind: true, teammateId: true, text: true },
    }),
  ])
  return {
    files,
    memory: {
      workspace: memory.find((m) => m.kind === 'workspace_memory')?.text ?? '',
      teammates: Object.fromEntries(
        memory
          .filter((m) => m.kind === 'teammate_memory' && m.teammateId)
          .map((m) => [m.teammateId!, m.text]),
      ),
    },
  }
}
