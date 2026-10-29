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
  changeMemoryFile,
  memoryLineKey,
  tidyTakesTooMuch,
  type ArchivedMemoryLine,
  type MemoryEdit,
  type MemoryLayout,
  type MemoryLineInfo,
  type MemoryLineMeta,
  type SearchHit,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { audit, type Actor } from './audit.js'
import { copyObject, documentKey, getObject, putObject } from './bucket.js'
import { notifyCollab } from './collab.js'
import { prisma, Prisma, scoped, type Scope, type ScopedDb } from './db.js'
import { hubs } from './hub.js'
import { folderRules, teammateLibraryAccess } from './library-folders.js'
import { actorNames, ensureFirstVersion, recordVersion } from './library-history.js'
import {
  applyMemoryEdit,
  applyMemoryLayout,
  planLineSync,
  type LineContext,
  type LineUpdate,
} from './memory-edit.js'
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
  input: { path: string; contentType?: string | null } & (
    | { bytes: Uint8Array }
    /** An upload, checked (uploads.ts): its bytes are copied inside the bucket, never read here. */
    | { upload: { key: string; size: number; sha256: string; text: string } }
  ),
  /** Recorded with the change, e.g. the thread a teammate saved it from (`sessionId`). */
  context: Record<string, string> = {},
  options: {
    /** Set when the collab server saves what people edited: its room already has it. */
    fromCollab?: boolean
    /** Set when the save brings back an older version. */
    restoredFromId?: string
    /** The stored text it builds on: when the file changed since, nothing is written (StaleMemory). */
    baseSha?: string
    /** Its caller holds the file's lock already (withLibraryLock). */
    locked?: boolean
  } = {},
): Promise<Awaited<ReturnType<typeof writeLibraryFile>>> {
  // A Markdown file is changed one save at a time: a list's lines are read, changed and written
  // back (src/lists.ts), and a save landing in between would be lost.
  if (!options.locked && contentTypeFor(input.path, input.contentType) === 'text/markdown') {
    const existing = await db.document.findFirst({
      where: { kind: 'library', path: input.path, deletedAt: null },
      select: { id: true },
    })
    if (existing)
      return withLibraryLock(scope, existing.id, () =>
        writeLibraryFile(db, scope, actor, input, context, options),
      )
  }
  return writeLibraryFile(db, scope, actor, input, context, options)
}

/**
 * Run `work` holding a library file's lock, which every save of a Markdown file takes: what it
 * reads of the file stays what it writes over.
 */
export function withLibraryLock<T>(scope: Scope, documentId: string, work: () => Promise<T>) {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${scope.workspaceId}:library:${documentId}`}))`
      return work()
    },
    { maxWait: 10_000, timeout: 30_000 },
  )
}

async function writeLibraryFile(
  db: ScopedDb,
  scope: Scope,
  actor: Actor,
  input: Parameters<typeof saveLibraryFile>[3],
  context: Record<string, string>,
  options: Parameters<typeof saveLibraryFile>[5] & {},
) {
  const size = 'bytes' in input ? input.bytes.byteLength : input.upload.size
  if (size > LIBRARY_FILE_MAX)
    throw new HTTPException(413, { message: 'Files in the library can be up to 25 MB' })
  const contentType = contentTypeFor(input.path, input.contentType)
  const hash = 'bytes' in input ? sha256(input.bytes) : input.upload.sha256
  const existing = await db.document.findFirst({
    where: { kind: 'library', path: input.path, deletedAt: null },
  })
  if (options.baseSha && existing && existing.sha256 !== options.baseSha) throw new StaleMemory()
  // The same bytes again: nothing changed, nothing to record.
  if (
    existing &&
    existing.sha256 === hash &&
    existing.contentType === contentType &&
    !options.restoredFromId
  )
    return existing
  const text = 'bytes' in input ? await extractText(input.bytes, contentType) : input.upload.text
  const sessionId = context.sessionId ?? null
  // Its bytes where they belong: written, or copied from the upload inside the bucket.
  const keep = async (key: string) => {
    if ('bytes' in input) return putObject(key, input.bytes, contentType)
    if (!(await copyObject(input.upload.key, key, contentType)))
      throw new HTTPException(409, { message: 'The upload is gone; upload it again' })
  }
  const fields = {
    contentType,
    size,
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
    await keep(documentKey(scope, existing.id))
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
    await keep(documentKey(scope, row.id)).catch(async (error) => {
      await db.document.delete({ where: { id: row!.id } })
      throw error
    })
  }
  await recordVersion(
    db,
    scope,
    row,
    'bytes' in input ? input.bytes : { key: input.upload.key },
    actor,
    {
      sessionId,
      ...(options.restoredFromId ? { restoredFromId: options.restoredFromId } : {}),
    },
  ).catch((error) => console.warn(`library: no version kept of ${row.id}: ${String(error)}`))
  await audit({
    ...scope,
    actor,
    action: existing ? 'library.file_replaced' : 'library.file_added',
    target: { type: 'document', id: row.id },
    data: { path: row.path, size: row.size, ...context },
  })
  void hubs.get(scope.workspaceId).notifyLibraryChanged()
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
  void hubs.get(scope.workspaceId).notifyLibraryChanged()
  return moved
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

type MemoryTarget =
  | { kind: 'workspace_memory' }
  | { kind: 'teammate_memory'; teammateId: string }
  | { kind: 'project_memory'; projectId: string }

const memoryPath = (target: MemoryTarget) =>
  target.kind === 'workspace_memory'
    ? 'workspace.md'
    : target.kind === 'teammate_memory'
      ? `teammates/${target.teammateId}.md`
      : `projects/${target.projectId}.md`

/** The row's link to its teammate or project. */
const memoryLinks = (target: MemoryTarget) =>
  target.kind === 'teammate_memory'
    ? { teammateId: target.teammateId }
    : target.kind === 'project_memory'
      ? { projectId: target.projectId }
      : {}

/** A new memory file: just its heading. The dashboard says what it is for. */
export function memoryHeader(target: MemoryTarget, name?: string) {
  return target.kind === 'workspace_memory'
    ? '# Workspace memory\n'
    : target.kind === 'teammate_memory'
      ? `# What ${name ?? 'this teammate'} has learned\n`
      : `# ${name ?? 'Project'} memory\n`
}

export async function readMemory(db: ScopedDb, target: MemoryTarget) {
  return db.document.findFirst({ where: { kind: target.kind, path: memoryPath(target) } })
}

/** The memory file, created with just its heading if nothing was remembered yet. */
export async function ensureMemory(
  db: ScopedDb,
  scope: Scope,
  target: MemoryTarget,
  name?: string,
) {
  return (
    (await readMemory(db, target)) ??
    upsertText(
      db,
      scope,
      target.kind,
      memoryPath(target),
      memoryHeader(target, name),
      memoryLinks(target),
    )
  )
}

/** Which memory file a document row is. */
export function memoryTarget(row: {
  kind: string
  teammateId: string | null
  projectId?: string | null
}): MemoryTarget {
  if (row.kind === 'workspace_memory') return { kind: 'workspace_memory' }
  if (row.kind === 'teammate_memory' && row.teammateId)
    return { kind: 'teammate_memory', teammateId: row.teammateId }
  if (row.kind === 'project_memory' && row.projectId)
    return { kind: 'project_memory', projectId: row.projectId }
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
  row: {
    id: string
    kind: string
    path: string
    contentType: string
    teammateId: string | null
    projectId?: string | null
  },
  text: string,
  options: { fromCollab?: boolean; baseSha?: string } = {},
) {
  if (row.kind === 'library')
    return saveLibraryFile(
      db,
      scope,
      actor,
      { path: row.path, bytes: new TextEncoder().encode(text), contentType: row.contentType },
      {},
      {
        fromCollab: options.fromCollab,
        ...(options.baseSha ? { baseSha: options.baseSha } : {}),
      },
    )
  if (text.length > MEMORY_MAX)
    throw new HTTPException(413, {
      message: `Memory files can be up to ${MEMORY_MAX.toLocaleString('en')} characters`,
    })
  return writeMemory(db, scope, actor, memoryTarget(row), text, options)
}

/**
 * A person's save built on a document's text that changed since: a memory file a thread or a
 * tidy run wrote to, a library file a teammate or a list's change wrote to.
 */
export class StaleMemory extends Error {
  constructor() {
    super('The memory changed since this edit started')
  }
}

type MemoryChange = {
  text: string
  context: Pick<LineContext, 'reasons' | 'confirm' | 'sources'>
  /** A tidy run laid it out. */
  tidied?: boolean
}

const noLineContext = (): MemoryChange['context'] => ({
  reasons: new Map(),
  confirm: new Set(),
  sources: new Map(),
})

/**
 * Change a memory file and bring its lines' rows along (dates, sources, the
 * archive), one change at a time per file, so threads ending together, tidy
 * runs and people editing never overwrite each other. `change` gets the
 * current file and returns its new text, or null to leave it as it is.
 */
async function changeMemory(
  scope: Scope,
  target: MemoryTarget & { name?: string },
  actor: Actor,
  sessionId: string | null,
  change: (
    current: { text: string; sha256: string; memoryTidiedAt: Date | null } | null,
  ) => MemoryChange | null,
) {
  // Only the workspace: a dashboard's scope also names its user and member, which no row has.
  const inWorkspace = { organizationId: scope.organizationId, workspaceId: scope.workspaceId }
  return prisma.$transaction(
    async (tx) => {
      const path = memoryPath(target)
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${scope.workspaceId}:${path}`}))`
      const current = await tx.document.findFirst({
        where: { ...inWorkspace, kind: target.kind, path },
      })
      const next = change(current)
      if (!next) return null
      const changed = current?.text !== next.text
      const fields = {
        text: next.text,
        size: Buffer.byteLength(next.text),
        sha256: sha256(next.text),
        indexed: true,
        ...(next.tidied ? { memoryTidiedAt: new Date() } : {}),
      }
      const row = !current
        ? await tx.document.create({
            data: {
              ...inWorkspace,
              kind: target.kind,
              path,
              contentType: 'text/markdown',
              ...memoryLinks(target),
              ...fields,
            },
          })
        : changed || next.tidied
          ? await tx.document.update({ where: { id: current.id }, data: fields })
          : current
      const rows = await tx.memoryLine.findMany({ where: { documentId: row.id } })
      const plan = planLineSync(current?.text ?? '', next.text, rows, {
        ...next.context,
        actor,
        sessionId,
        now: new Date(),
      })
      if (plan.create.length)
        await tx.memoryLine.createMany({
          data: plan.create.map((line) => ({ ...inWorkspace, documentId: row.id, ...line })),
        })
      // Rows that change the same way (a topic, a confirmation) change together.
      const groups = new Map<string, { data: LineUpdate; ids: string[] }>()
      for (const { id, data } of plan.update) {
        const key = JSON.stringify(data)
        const group = groups.get(key)
        if (group) group.ids.push(id)
        else groups.set(key, { data, ids: [id] })
      }
      for (const { data, ids } of groups.values())
        await tx.memoryLine.updateMany({ where: { id: { in: ids } }, data })
      if (plan.delete.length) await tx.memoryLine.deleteMany({ where: { id: { in: plan.delete } } })
      return { row, changed }
    },
    { timeout: 30_000 },
  )
}

/** Replace a memory file's text (a person correcting it). */
export async function writeMemory(
  _db: ScopedDb,
  scope: Scope,
  actor: Actor,
  target: MemoryTarget,
  text: string,
  /**
   * fromCollab: the collab server saves what people edited, and its room already has it.
   * baseSha: the text the edit was made on; if a thread or a tidy run changed it since,
   * nothing is written (StaleMemory) and the room reconciles first.
   */
  options: { fromCollab?: boolean; baseSha?: string } = {},
) {
  const { row } = (await changeMemory(scope, target, actor, null, (current) => {
    // Checked under the file's lock: a thread's edit cannot land between the check and the write.
    if (options.baseSha && current && current.sha256 !== options.baseSha) throw new StaleMemory()
    return { text, context: noLineContext() }
  }))!
  await audit({
    ...scope,
    actor,
    action: 'memory.written',
    target: { type: 'document', id: row.id },
    data: { kind: target.kind, ...memoryLinks(target) },
  })
  void hubs.get(scope.workspaceId).notifyLibraryChanged()
  if (!options.fromCollab) notifyCollab(row.id)
  return row
}

const editIsEmpty = (edit: MemoryEdit) =>
  !edit.add.length &&
  !edit.remove.length &&
  !edit.lines.length &&
  !edit.replace.length &&
  !edit.archive.length &&
  !edit.confirm.length

/** Apply a thread's edit to a memory file, creating it on first use. */
export async function editMemory(
  _db: ScopedDb,
  scope: Scope,
  actor: Actor,
  /** name: the teammate's or the project's, for a new file's heading. */
  target: MemoryTarget & { name?: string },
  edit: MemoryEdit,
  sessionId: string,
) {
  if (editIsEmpty(edit)) return
  let result: ReturnType<typeof applyMemoryEdit> | undefined
  const done = await changeMemory(scope, target, actor, sessionId, (current) => {
    const text = current?.text ?? memoryHeader(target, target.name)
    result = applyMemoryEdit(text, edit)
    const changes = result.added.length + result.replaced.length + result.removed.length
    return {
      // Only confirmations: the file stays exactly as people wrote it.
      text: changes ? result.text : text,
      context: { ...noLineContext(), reasons: result.reasons, confirm: result.confirm },
    }
  })
  if (!done || !result) return
  const path = memoryPath(target)
  if (result.dropped > 0)
    console.warn(`memory ${path}: full, ${result.dropped} new lines left out (thread ${sessionId})`)
  if (done.changed || result.dropped > 0)
    await audit({
      ...scope,
      actor,
      action: 'memory.updated',
      target: { type: 'document', id: done.row.id },
      data: {
        kind: target.kind,
        sessionId,
        added: result.added.length,
        replaced: result.replaced.length,
        removed: result.removed.length,
        confirmed: edit.confirm.length,
        ...(result.dropped ? { dropped: result.dropped } : {}),
      },
    })
  // Merged into what people may be editing, line by line as the thread asked.
  if (done.changed) notifyCollab(done.row.id)
  return done.row
}

/**
 * Lay a memory file out again as a tidy run asked: core within budget, topics,
 * repeats merged, outdated lines archived. Dropped when the file was tidied
 * again since the run read it.
 */
export async function tidyMemory(
  scope: Scope,
  actor: Actor,
  target: MemoryTarget & { name?: string },
  layout: MemoryLayout,
  input: { sessionId: string; lastTidied: string | null },
) {
  let result: ReturnType<typeof applyMemoryLayout> | undefined
  const done = await changeMemory(scope, target, actor, input.sessionId, (current) => {
    if (!current) return null
    if ((current.memoryTidiedAt?.toISOString() ?? null) !== input.lastTidied) return null
    result = applyMemoryLayout(current.text, layout)
    // Whatever the runner checked: a layout that takes most of the file away is not applied.
    if (tidyTakesTooMuch(current.text, result.text)) {
      console.warn(`memory ${memoryPath(target)}: a tidy run would take too much away; not applied`)
      return null
    }
    return {
      text: result.text,
      tidied: true,
      context: { ...noLineContext(), reasons: result.reasons, sources: result.sources },
    }
  })
  if (!done || !result) return null
  await audit({
    ...scope,
    actor,
    action: 'memory.tidied',
    target: { type: 'document', id: done.row.id },
    data: {
      kind: target.kind,
      sessionId: input.sessionId,
      archived: result.archived.length,
      merged: result.merged.length,
      moved: result.moved.length,
    },
  })
  if (done.changed) {
    notifyCollab(done.row.id)
    void hubs.get(scope.workspaceId).notifyLibraryChanged()
  }
  return done.row
}

/** When a line was learned or last confirmed. */
const lineDate = (row: { createdAt: Date; confirmedAt: Date | null }) =>
  row.confirmedAt && row.confirmedAt > row.createdAt ? row.confirmedAt : row.createdAt

/** Each memory file's live lines (date and source, by key), and how many lines it archived. */
export async function memoryLineInfo(db: ScopedDb, documentIds: string[]) {
  const out = new Map<string, { lines: Record<string, MemoryLineInfo>; archived: number }>()
  if (!documentIds.length) return out
  const rows = await db.memoryLine.findMany({
    where: { documentId: { in: documentIds } },
    select: {
      documentId: true,
      text: true,
      createdAt: true,
      confirmedAt: true,
      legacy: true,
      createdByType: true,
      createdById: true,
      sessionId: true,
      archivedAt: true,
    },
  })
  const name = await actorNames(
    db,
    rows.flatMap((r) =>
      r.createdByType === 'member' && r.createdById && !r.archivedAt
        ? [{ type: 'member', id: r.createdById }]
        : [],
    ),
  )
  const sessionIds = [
    ...new Set(rows.flatMap((r) => (r.sessionId && !r.archivedAt ? [r.sessionId] : []))),
  ]
  const titles = new Map(
    (sessionIds.length
      ? await db.session.findMany({
          where: { id: { in: sessionIds } },
          select: { id: true, title: true },
        })
      : []
    ).map((s) => [s.id, s.title]),
  )
  for (const id of documentIds) out.set(id, { lines: {}, archived: 0 })
  for (const row of rows) {
    const file = out.get(row.documentId)!
    if (row.archivedAt) {
      file.archived++
      continue
    }
    file.lines[memoryLineKey(row.text)] = {
      at: lineDate(row).toISOString(),
      legacy: row.legacy,
      by: row.createdByType === 'member' ? (name('member', row.createdById)?.name ?? null) : null,
      sessionId: row.sessionId,
      threadTitle: row.sessionId ? (titles.get(row.sessionId) ?? null) : null,
    }
  }
  return out
}

/** A memory file's archived lines, newest first; `query` filters by their text. */
export async function archivedMemoryLines(
  db: ScopedDb,
  documentId: string,
  query: string,
): Promise<ArchivedMemoryLine[]> {
  const rows = await db.memoryLine.findMany({
    where: {
      documentId,
      archivedAt: { not: null },
      ...(query ? { text: { contains: query, mode: 'insensitive' as const } } : {}),
    },
    orderBy: { archivedAt: 'desc' },
    take: 200,
  })
  const name = await actorNames(
    db,
    rows.flatMap((r) =>
      r.archivedByType && r.archivedById ? [{ type: r.archivedByType, id: r.archivedById }] : [],
    ),
  )
  const sessionIds = [...new Set(rows.flatMap((r) => (r.sessionId ? [r.sessionId] : [])))]
  const titles = new Map(
    (sessionIds.length
      ? await db.session.findMany({
          where: { id: { in: sessionIds } },
          select: { id: true, title: true },
        })
      : []
    ).map((s) => [s.id, s.title]),
  )
  return rows.map((r) => ({
    id: r.id,
    text: r.text,
    topic: r.topic,
    reason: r.archivedReason ?? 'Removed',
    archivedAt: r.archivedAt!.toISOString(),
    archivedBy: name(r.archivedByType, r.archivedById)?.name ?? null,
    createdAt: r.createdAt.toISOString(),
    sessionId: r.sessionId,
    threadTitle: r.sessionId ? (titles.get(r.sessionId) ?? null) : null,
  }))
}

/** Put an archived line back in its memory file, under the topic it was in. */
export async function restoreMemoryLine(db: ScopedDb, scope: Scope, actor: Actor, lineId: string) {
  const line = await db.memoryLine.findFirst({
    where: { id: lineId, archivedAt: { not: null } },
    include: { document: true },
  })
  if (!line) throw new HTTPException(404, { message: 'This line is not in the archive' })
  const target = memoryTarget(line.document)
  let full = false
  const done = await changeMemory(scope, target, actor, null, (current) => {
    const result = changeMemoryFile(
      current?.text ?? '',
      { add: [{ text: line.text, topic: line.topic }] },
      MEMORY_MAX,
    )
    full = result.dropped > 0
    return result.added.length ? { text: result.text, context: noLineContext() } : null
  })
  if (full)
    throw new HTTPException(413, {
      message: `This memory is full (${MEMORY_MAX.toLocaleString('en')} characters): remove a line first`,
    })
  if (!done) return
  await audit({
    ...scope,
    actor,
    action: 'memory.restored',
    target: { type: 'document', id: done.row.id },
    data: { kind: target.kind, line: line.text },
  })
  notifyCollab(done.row.id)
  void hubs.get(scope.workspaceId).notifyLibraryChanged()
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
  kind: 'workspace_memory' | 'teammate_memory' | 'project_memory' | 'thread_summary',
  path: string,
  text: string,
  links: { teammateId?: string; sessionId?: string; projectId?: string },
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
      projectName: string | null
      title: string | null
      snippet: string
    }[]
  >`
    WITH q AS (
      SELECT websearch_to_tsquery('english', ${input.query}) || websearch_to_tsquery('simple', ${input.query}) AS query
    )
    SELECT d.id, d.kind, d.path, d."sessionId", t.name AS "teammateName", p.name AS "projectName", s.title,
      ts_headline('english', left(d.text, 100000), q.query,
        'StartSel=«, StopSel=», MaxFragments=2, MaxWords=35, MinWords=12, FragmentDelimiter=" … "') AS snippet
    FROM "Document" d
    CROSS JOIN q
    LEFT JOIN "Session" s ON s.id = d."sessionId"
    LEFT JOIN "Teammate" t ON t.id = d."teammateId"
    LEFT JOIN "Project" p ON p.id = d."projectId"
    WHERE d."organizationId" = ${scope.organizationId}
      AND d."workspaceId" = ${scope.workspaceId}
      AND d.search @@ q.query
      AND d."deletedAt" IS NULL
      ${ownMemory}
      ${summaries}
    ORDER BY ts_rank(d.search, q.query) DESC, d."updatedAt" DESC
    LIMIT ${limit}`
  // Lines removed from memory (replaced, merged, outdated): a few, after the files, to tell what was decided before.
  const ownArchive = input.teammate
    ? Prisma.sql`AND (d.kind <> 'teammate_memory' OR d."teammateId" = ${input.teammate.id})`
    : Prisma.empty
  const archived = await prisma.$queryRaw<
    {
      documentId: string
      kind: string
      path: string
      teammateName: string | null
      projectName: string | null
      reason: string | null
      archivedAt: Date
      sessionId: string | null
      snippet: string
    }[]
  >`
    WITH q AS (
      SELECT websearch_to_tsquery('english', ${input.query}) || websearch_to_tsquery('simple', ${input.query}) AS query
    )
    SELECT l."documentId", d.kind, d.path, t.name AS "teammateName", p.name AS "projectName",
      l."archivedReason" AS reason, l."archivedAt", l."sessionId",
      ts_headline('english', l.text, q.query, 'StartSel=«, StopSel=», HighlightAll=true') AS snippet
    FROM "MemoryLine" l
    CROSS JOIN q
    JOIN "Document" d ON d.id = l."documentId"
    LEFT JOIN "Teammate" t ON t.id = d."teammateId"
    LEFT JOIN "Project" p ON p.id = d."projectId"
    WHERE l."organizationId" = ${scope.organizationId}
      AND l."workspaceId" = ${scope.workspaceId}
      AND l."archivedAt" IS NOT NULL
      AND l.search @@ q.query
      ${ownArchive}
    ORDER BY ts_rank(l.search, q.query) DESC, l."archivedAt" DESC
    LIMIT ${Math.min(3, Math.ceil(input.limit / 4))}`
  const day = (d: Date) => d.toISOString().slice(0, 10)
  const archivedHits: SearchHit[] = archived.map((r) => ({
    kind: 'archived_memory',
    path: r.path,
    documentId: r.documentId,
    sessionId: r.sessionId,
    title: `Archived from ${
      r.kind === 'workspace_memory'
        ? 'workspace memory'
        : r.kind === 'teammate_memory'
          ? `${r.teammateName ?? 'a teammate'}'s memory`
          : `${r.projectName ?? 'a project'}'s memory`
    } on ${day(r.archivedAt)}: ${r.reason ?? 'removed'}`,
    snippet: r.snippet,
  }))
  return rows
    .filter((r) => r.kind !== 'library' || !access || access.of(r.path) !== 'none')
    .slice(0, input.limit - archivedHits.length)
    .map((r): SearchHit => ({
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
              : r.kind === 'project_memory'
                ? `${r.projectName ?? 'A project'}'s memory`
                : `Thread: ${r.title ?? r.sessionId}`,
      snippet: r.snippet,
    }))
    .concat(archivedHits)
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
      where: { kind: { in: ['workspace_memory', 'teammate_memory', 'project_memory'] } },
      select: {
        id: true,
        kind: true,
        path: true,
        teammateId: true,
        projectId: true,
        text: true,
        memoryTidiedAt: true,
      },
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
      projects: Object.fromEntries(
        memory
          .filter((m) => m.kind === 'project_memory' && m.projectId)
          .map((m) => [m.projectId!, m.text]),
      ),
      lines: await memoryLineMeta(db, memory),
      tidied: Object.fromEntries(
        memory.flatMap((m) => (m.memoryTidiedAt ? [[m.path, m.memoryTidiedAt.toISOString()]] : [])),
      ),
    },
    access,
  }
}

/** Each memory file's live lines, by path and key: when learned or confirmed, and who wrote it when a person did. */
async function memoryLineMeta(db: ScopedDb, files: { id: string; path: string }[]) {
  const rows = await db.memoryLine.findMany({
    where: { documentId: { in: files.map((f) => f.id) }, archivedAt: null },
    select: {
      documentId: true,
      text: true,
      createdAt: true,
      confirmedAt: true,
      legacy: true,
      createdByType: true,
      createdById: true,
    },
  })
  const name = await actorNames(
    db,
    rows.flatMap((r) =>
      r.createdByType === 'member' && r.createdById ? [{ type: 'member', id: r.createdById }] : [],
    ),
  )
  const paths = new Map(files.map((f) => [f.id, f.path]))
  const out: Record<string, Record<string, MemoryLineMeta>> = {}
  for (const row of rows) {
    const path = paths.get(row.documentId)!
    const by = row.createdByType === 'member' ? name('member', row.createdById)?.name : undefined
    ;(out[path] ??= {})[memoryLineKey(row.text)] = {
      at: lineDate(row).toISOString(),
      ...(by ? { by } : {}),
      ...(row.legacy ? { legacy: true } : {}),
    }
  }
  return out
}
