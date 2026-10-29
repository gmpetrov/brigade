// The library and memory, from the dashboard. Any member may upload, read,
// edit and correct; every change is audited and synced to the computers.
import {
  CreateLibraryFolder,
  CreateLibraryText,
  EditTarget,
  LibraryPath,
  MoveLibraryFile,
  MoveLibraryFolder,
  SaveLibraryUpload,
  SetFolderAccess,
  LIBRARY_FILE_MAX,
  TRASH_DAYS,
  WriteLibraryText,
  WriteMemory,
  type EditSession,
  type LibraryTree,
  type LibraryVersion,
  type MemoryFile,
  type MemoryOverview,
  type TrashedFile,
} from '@brigade/contracts'
import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { directUploads } from '../bucket.js'
import { collabEnabled, COLLAB_PARTY, cursorColor, editToken } from '../collab.js'
import { env } from '../config.js'
import { prisma } from '../db.js'
import {
  createFolder,
  explicitFolders,
  moveFolder,
  setFolderAccess,
  trashFolder,
} from '../library-folders.js'
import {
  actorNames,
  ensureFirstVersion,
  originalPath,
  purgeLibraryFile,
  readVersion,
  restoreLibraryFile,
  trashLibraryFile,
} from '../library-history.js'
import {
  documentText,
  ensureMemory,
  isEditable,
  isMarkdown,
  libraryFile,
  libraryFileOf,
  libraryFiles,
  memoryHeader,
  memoryLineInfo,
  archivedMemoryLines,
  restoreMemoryLine,
  moveLibraryFile,
  readLibraryFile,
  readMemory,
  saveDocumentText,
  saveLibraryFile,
  search,
  writeMemory,
} from '../library.js'
import { fileKey, versionBytesKey } from '../library-objects.js'
import { libraryPreview } from '../previews.js'
import { parseBody, requireRole, requireUser, requireWorkspace, type AppEnv } from '../scope.js'
import { serveObject } from '../serve-object.js'
import { discardUpload, readyUpload, uploadBytesKey } from '../uploads.js'

/** Types the browser may show inline from the API's origin; anything else downloads. */
const INLINE =
  /^(text\/plain|text\/markdown|text\/csv|text\/tab-separated-values|application\/json|application\/pdf|image\/(png|jpeg|gif|webp|avif)|video\/(mp4|webm|quicktime)|audio\/(mpeg|mp4|wav|ogg))$/

/** A file's bytes, to show or download, as they stream. Never run as a page on this origin. */
function fileResponse(
  c: Context,
  key: string,
  file: { path: string; contentType: string },
  download: boolean,
) {
  const inline = !download && INLINE.test(file.contentType)
  const name = file.path.split('/').pop()!
  return serveObject(c, key, {
    'content-type': file.contentType.startsWith('text/')
      ? `${file.contentType}; charset=utf-8`
      : file.contentType,
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
    'x-content-type-options': 'nosniff',
    'content-security-policy': 'sandbox',
    'cache-control': 'private, no-cache',
  })
}

const folderParam = (value: string | undefined) => {
  const path = LibraryPath.safeParse(value ?? '')
  if (!path.success) throw new HTTPException(400, { message: 'Name a folder' })
  return path.data
}

const memoryFile = (
  kind: MemoryFile['kind'],
  row: { id: string; text: string; updatedAt: Date } | null,
  header: string,
  info: Awaited<ReturnType<typeof memoryLineInfo>>,
): MemoryFile => ({
  kind,
  text: row?.text ?? header,
  updatedAt: row?.updatedAt.toISOString() ?? null,
  documentId: row?.id ?? null,
  lines: (row && info.get(row.id)?.lines) ?? {},
  archived: (row && info.get(row.id)?.archived) ?? 0,
})

/** A memory file of this workspace, by its document id. */
async function memoryDocument(db: AppEnv['Variables']['db'], id: string) {
  const row = await db.document.findFirst({
    where: { id, kind: { in: ['workspace_memory', 'teammate_memory', 'project_memory'] } },
  })
  if (!row) throw new HTTPException(404, { message: 'Memory not found' })
  return row
}

export const library = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)

  .get('/', async (c) => {
    const { db } = c.var
    const rows = await db.document.findMany({
      where: { kind: 'library', deletedAt: null },
      orderBy: { path: 'asc' },
    })
    return c.json(await libraryFiles(db, rows))
  })

  /** The files, the folders people made or set access on, and this member's pins, at once. */
  .get('/tree', async (c) => {
    const { db, scope } = c.var
    const [rows, folders, pins] = await Promise.all([
      db.document.findMany({
        where: { kind: 'library', deletedAt: null },
        orderBy: { path: 'asc' },
      }),
      explicitFolders(db),
      db.documentPin.findMany({
        where: { memberId: scope.memberId, document: { deletedAt: null } },
        orderBy: { pinnedAt: 'asc' },
        select: { documentId: true },
      }),
    ])
    return c.json({
      files: await libraryFiles(db, rows),
      folders,
      pinned: pins.map((p) => p.documentId),
    } satisfies LibraryTree)
  })

  /** The folders people made or set access on. */
  .get('/folders', async (c) => c.json(await explicitFolders(c.var.db)))

  .post('/folders', async (c) => {
    const { scope, db } = c.var
    const { path } = await parseBody(c.req.raw, CreateLibraryFolder)
    await createFolder(db, scope, { type: 'member', id: scope.memberId }, path)
    return c.json({ path }, 201)
  })

  /** Rename or move a folder, with everything in it. */
  .patch('/folders', async (c) => {
    const { scope, db } = c.var
    const { path, to } = await parseBody(c.req.raw, MoveLibraryFolder)
    await moveFolder(db, scope, { type: 'member', id: scope.memberId }, path, to)
    return c.json({ path: to })
  })

  /** Everything in the folder goes to the trash. */
  .delete('/folders', async (c) => {
    const { scope, db } = c.var
    await trashFolder(
      db,
      scope,
      { type: 'member', id: scope.memberId },
      folderParam(c.req.query('path')),
    )
    return c.body(null, 204)
  })

  /** Which teammates reach a folder. Admins only, like every other teammate grant. */
  .put('/folders/access', async (c) => {
    requireRole(c.var.scope, 'owner', 'admin')
    const { scope, db } = c.var
    const input = await parseBody(c.req.raw, SetFolderAccess)
    await setFolderAccess(db, scope, { type: 'member', id: scope.memberId }, input)
    return c.json({ ok: true })
  })

  .get('/trash', async (c) => {
    const { db } = c.var
    const rows = await db.document.findMany({
      where: { kind: 'library', deletedAt: { not: null } },
      orderBy: { deletedAt: 'desc' },
    })
    const who = await actorNames(
      db,
      rows.map((r) => ({ type: r.deletedByType ?? '', id: r.deletedById ?? '' })),
    )
    return c.json(
      rows.map((r): TrashedFile => ({
        id: r.id,
        path: originalPath(r.path),
        contentType: r.contentType,
        size: r.size,
        deletedAt: r.deletedAt!.toISOString(),
        deletedBy: who(r.deletedByType, r.deletedById),
        purgeAt: new Date(r.deletedAt!.getTime() + TRASH_DAYS * 24 * 60 * 60_000).toISOString(),
      })),
    )
  })

  .post('/trash/:id/restore', async (c) => {
    const { scope, db } = c.var
    const row = await restoreLibraryFile(
      db,
      scope,
      { type: 'member', id: scope.memberId },
      c.req.param('id'),
    )
    return c.json(await libraryFileOf(db, row))
  })

  /** Delete one file for good. */
  .delete('/trash/:id', async (c) => {
    const { scope, db } = c.var
    await purgeLibraryFile(db, scope, { type: 'member', id: scope.memberId }, c.req.param('id'))
    return c.body(null, 204)
  })

  /** Empty the trash. */
  .delete('/trash', async (c) => {
    const { scope, db } = c.var
    const rows = await db.document.findMany({
      where: { kind: 'library', deletedAt: { not: null } },
      select: { id: true },
    })
    for (const row of rows)
      await purgeLibraryFile(db, scope, { type: 'member', id: scope.memberId }, row.id)
    return c.body(null, 204)
  })

  /** Save a file uploaded straight to the bucket (POST /api/uploads, then its complete). */
  .post('/files', async (c) => {
    const { scope, db } = c.var
    const { path, uploadId } = await parseBody(c.req.raw, SaveLibraryUpload)
    const upload = await readyUpload(db, { memberId: scope.memberId }, uploadId, 'library')
    const row = await saveLibraryFile(
      db,
      scope,
      { type: 'member', id: scope.memberId },
      {
        path,
        contentType: upload.contentType,
        upload: {
          key: uploadBytesKey(scope, upload),
          size: upload.size,
          sha256: upload.sha256,
          text: upload.text,
        },
      },
    )
    await discardUpload(scope, upload.id)
    return c.json(await libraryFileOf(db, row), 201)
  })

  /**
   * Upload one file (multipart: `file`, and `path` to put it somewhere other than its name).
   * Only without R2 (development): with it, files go straight to the bucket (/files).
   */
  .post('/upload', async (c) => {
    const { scope, db } = c.var
    if (directUploads) throw new HTTPException(400, { message: 'Upload to the bucket' })
    if (Number(c.req.header('content-length') ?? 0) > LIBRARY_FILE_MAX + 64 * 1024)
      throw new HTTPException(413, { message: 'Files in the library can be up to 25 MB' })
    const form = await c.req.parseBody()
    const file = form.file
    if (!(file instanceof File)) throw new HTTPException(400, { message: 'Attach a file' })
    const path = LibraryPath.safeParse(
      typeof form.path === 'string' && form.path ? form.path : file.name,
    )
    if (!path.success) throw new HTTPException(400, { message: path.error.issues[0]!.message })
    const row = await saveLibraryFile(
      db,
      scope,
      { type: 'member', id: scope.memberId },
      { path: path.data, bytes: new Uint8Array(await file.arrayBuffer()), contentType: file.type },
    )
    return c.json(await libraryFileOf(db, row), 201)
  })

  /** A new text file written in the dashboard. */
  .post('/text', async (c) => {
    const { scope, db } = c.var
    const input = await parseBody(c.req.raw, CreateLibraryText)
    if (await db.document.findFirst({ where: { kind: 'library', path: input.path } }))
      throw new HTTPException(409, { message: 'A file already has that path' })
    const row = await saveLibraryFile(
      db,
      scope,
      { type: 'member', id: scope.memberId },
      { path: input.path, bytes: new TextEncoder().encode(input.text) },
    )
    return c.json(await libraryFileOf(db, row), 201)
  })

  /** Full-text search over the library, memory and thread summaries. */
  .get('/search', async (c) => {
    const query = (c.req.query('q') ?? '').trim().slice(0, 500)
    if (!query) return c.json([])
    return c.json(await search(c.var.scope, { query, limit: 30, memberId: c.var.scope.memberId }))
  })

  .get('/memory', async (c) => {
    const { db, scope } = c.var
    const [workspace, teammates, memories, projects, projectMemories, summaries] =
      await Promise.all([
        readMemory(db, { kind: 'workspace_memory' }),
        db.teammate.findMany({ where: { archivedAt: null }, orderBy: { createdAt: 'asc' } }),
        db.document.findMany({ where: { kind: 'teammate_memory' } }),
        db.project.findMany({ where: { archivedAt: null }, orderBy: { createdAt: 'asc' } }),
        db.document.findMany({ where: { kind: 'project_memory' } }),
        db.document.findMany({
          where: {
            kind: 'thread_summary',
            session: { OR: [{ private: false }, { startedByMemberId: scope.memberId }] },
          },
          include: { session: { select: { title: true } } },
          orderBy: { updatedAt: 'desc' },
          take: 50,
        }),
      ])
    const info = await memoryLineInfo(db, [
      ...(workspace ? [workspace.id] : []),
      ...memories.map((m) => m.id),
      ...projectMemories.map((m) => m.id),
    ])
    const overview: MemoryOverview = {
      workspace: memoryFile(
        'workspace_memory',
        workspace,
        memoryHeader({ kind: 'workspace_memory' }),
        info,
      ),
      teammates: teammates.map((t) => ({
        teammateId: t.id,
        name: t.name,
        memory: memoryFile(
          'teammate_memory',
          memories.find((m) => m.teammateId === t.id) ?? null,
          memoryHeader({ kind: 'teammate_memory', teammateId: t.id }, t.name),
          info,
        ),
      })),
      projects: projects.map((p) => ({
        projectId: p.id,
        name: p.name,
        memory: memoryFile(
          'project_memory',
          projectMemories.find((m) => m.projectId === p.id) ?? null,
          memoryHeader({ kind: 'project_memory', projectId: p.id }, p.name),
          info,
        ),
      })),
      summaries: summaries.map((s) => ({
        sessionId: s.sessionId!,
        title: s.session?.title ?? 'Thread',
        teammateId: s.teammateId,
        text: s.text,
        updatedAt: s.updatedAt.toISOString(),
      })),
    }
    return c.json(overview)
  })

  /** A memory file's archived lines, newest first; ?q= filters by text. */
  .get('/memory/:documentId/archive', async (c) => {
    const { db } = c.var
    const row = await memoryDocument(db, c.req.param('documentId'))
    const query = (c.req.query('q') ?? '').trim().slice(0, 200)
    return c.json(await archivedMemoryLines(db, row.id, query))
  })

  /** Put an archived line back in its memory file. */
  .post('/memory/:documentId/archive/:lineId/restore', async (c) => {
    const { db, scope } = c.var
    await memoryDocument(db, c.req.param('documentId'))
    await restoreMemoryLine(
      db,
      scope,
      { type: 'member', id: scope.memberId },
      c.req.param('lineId'),
    )
    return c.json({ ok: true })
  })

  .put('/memory/workspace', async (c) => {
    const { db, scope } = c.var
    const { text } = await parseBody(c.req.raw, WriteMemory)
    await writeMemory(
      db,
      scope,
      { type: 'member', id: scope.memberId },
      { kind: 'workspace_memory' },
      text,
    )
    return c.json({ ok: true })
  })

  .put('/memory/teammates/:id', async (c) => {
    const { db, scope } = c.var
    const teammate = await db.teammate.findFirst({
      where: { id: c.req.param('id'), archivedAt: null },
    })
    if (!teammate) throw new HTTPException(404, { message: 'Teammate not found' })
    const { text } = await parseBody(c.req.raw, WriteMemory)
    await writeMemory(
      db,
      scope,
      { type: 'member', id: scope.memberId },
      { kind: 'teammate_memory', teammateId: teammate.id },
      text,
    )
    return c.json({ ok: true })
  })

  /**
   * Open a Markdown file or a memory file to edit (memory is created on first
   * open). Live through the collab server when it is configured.
   */
  .post('/edit', async (c) => {
    const { db, scope } = c.var
    const target = await parseBody(c.req.raw, EditTarget)
    let row
    if (target.kind === 'library') {
      row = await libraryFile(db, target.id)
      if (!isMarkdown(row))
        throw new HTTPException(400, { message: 'Only Markdown files open in the editor' })
    } else if (target.kind === 'workspace_memory') {
      row = await ensureMemory(db, scope, target)
    } else if (target.kind === 'project_memory') {
      const project = await db.project.findFirst({ where: { id: target.projectId } })
      if (!project) throw new HTTPException(404, { message: 'Project not found' })
      row = await ensureMemory(db, scope, target, project.name)
    } else {
      const teammate = await db.teammate.findFirst({
        where: { id: target.teammateId, archivedAt: null },
      })
      if (!teammate) throw new HTTPException(404, { message: 'Teammate not found' })
      row = await ensureMemory(db, scope, target, teammate.name)
    }
    let live: EditSession['live'] = null
    if (collabEnabled()) {
      const user = await prisma.user.findUnique({ where: { id: scope.userId } })
      const name = user?.name || user?.email || 'Someone'
      live = {
        url: env.COLLAB_URL,
        party: COLLAB_PARTY,
        room: row.id,
        token: editToken({ room: row.id, memberId: scope.memberId, name }),
        user: { name, color: cursorColor(scope.memberId) },
      }
    }
    const session: EditSession = {
      documentId: row.id,
      text: await documentText(scope, row),
      live,
    }
    return c.json(session)
  })

  /** Save an opened document whole, when the collab server is not configured. */
  .put('/edit/:documentId', async (c) => {
    const { db, scope } = c.var
    const row = await db.document.findFirst({
      where: { id: c.req.param('documentId'), deletedAt: null },
    })
    if (!row || !isMarkdown(row)) throw new HTTPException(404, { message: 'Document not found' })
    const { text } = await parseBody(c.req.raw, WriteLibraryText)
    await saveDocumentText(db, scope, { type: 'member', id: scope.memberId }, row, text)
    return c.json({ ok: true })
  })

  /** The file's bytes. Shown inline only for types that cannot run script on this origin. */
  .get('/:id/content', async (c) => {
    const row = await libraryFile(c.var.db, c.req.param('id'))
    return fileResponse(c, fileKey(c.var.scope, row), row, c.req.query('download') !== undefined)
  })

  /** A Word document, spreadsheet or deck, readable in the dashboard. `?version=` for an older one. */
  .get('/:id/preview', async (c) => {
    const { db, scope } = c.var
    const row = await libraryFile(db, c.req.param('id'))
    const versionId = c.req.query('version')
    const version = versionId
      ? await db.documentVersion.findFirst({ where: { id: versionId, documentId: row.id } })
      : null
    if (versionId && !version) throw new HTTPException(404, { message: 'Version not found' })
    const bytes = version ? await readVersion(scope, version) : await readLibraryFile(scope, row)
    return c.json(await libraryPreview(bytes, version?.contentType ?? row.contentType))
  })

  /** Every kept version, newest first. */
  .get('/:id/versions', async (c) => {
    const { db, scope } = c.var
    const row = await libraryFile(db, c.req.param('id'))
    await ensureFirstVersion(db, scope, row)
    const versions = await db.documentVersion.findMany({
      where: { documentId: row.id },
      orderBy: { createdAt: 'desc' },
    })
    const who = await actorNames(
      db,
      versions.map((v) => ({ type: v.actorType, id: v.actorId })),
    )
    return c.json(
      versions.map((v, i): LibraryVersion => ({
        id: v.id,
        path: v.path,
        contentType: v.contentType,
        size: v.size,
        sha256: v.sha256,
        by: who(v.actorType, v.actorId, v.sessionId)!,
        restoredFromId: v.restoredFromId,
        createdAt: v.createdAt.toISOString(),
        updatedAt: v.updatedAt.toISOString(),
        current: i === 0 && v.sha256 === row.sha256,
      })),
    )
  })

  .get('/:id/versions/:versionId/content', async (c) => {
    const { db, scope } = c.var
    const row = await libraryFile(db, c.req.param('id'))
    const version = await db.documentVersion.findFirst({
      where: { id: c.req.param('versionId'), documentId: row.id },
    })
    if (!version) throw new HTTPException(404, { message: 'Version not found' })
    return fileResponse(
      c,
      versionBytesKey(scope, version),
      version,
      c.req.query('download') !== undefined,
    )
  })

  /** Make an older version the current one. The newer ones stay in the history. */
  .post('/:id/versions/:versionId/restore', async (c) => {
    const { db, scope } = c.var
    const row = await libraryFile(db, c.req.param('id'))
    const version = await db.documentVersion.findFirst({
      where: { id: c.req.param('versionId'), documentId: row.id },
    })
    if (!version) throw new HTTPException(404, { message: 'Version not found' })
    const saved = await saveLibraryFile(
      db,
      scope,
      { type: 'member', id: scope.memberId },
      {
        path: row.path,
        bytes: await readVersion(scope, version),
        contentType: version.contentType,
      },
      { restoredFrom: version.id },
      { restoredFromId: version.id },
    )
    return c.json(await libraryFileOf(db, saved))
  })

  /** Replace a text file's contents. */
  .put('/:id/text', async (c) => {
    const { scope, db } = c.var
    const row = await libraryFile(db, c.req.param('id'))
    if (!isEditable(row))
      throw new HTTPException(400, { message: 'Only text files can be edited here' })
    const { text } = await parseBody(c.req.raw, WriteLibraryText)
    const saved = await saveLibraryFile(
      db,
      scope,
      { type: 'member', id: scope.memberId },
      { path: row.path, bytes: new TextEncoder().encode(text), contentType: row.contentType },
    )
    return c.json(await libraryFileOf(db, saved))
  })

  /** Pin it to the top of this member's Library; DELETE unpins it. Each member's own. */
  .post('/:id/pin', async (c) => {
    const { scope, db } = c.var
    const row = await libraryFile(db, c.req.param('id'))
    await db.documentPin.upsert({
      where: { memberId_documentId: { memberId: scope.memberId, documentId: row.id } },
      create: {
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
        memberId: scope.memberId,
        documentId: row.id,
      },
      update: {},
    })
    return c.json({ ok: true })
  })
  .delete('/:id/pin', async (c) => {
    const { scope, db } = c.var
    await db.documentPin.deleteMany({
      where: { memberId: scope.memberId, documentId: c.req.param('id') },
    })
    return c.json({ ok: true })
  })

  /** Rename or move. */
  .patch('/:id', async (c) => {
    const { scope, db } = c.var
    const { path } = await parseBody(c.req.raw, MoveLibraryFile)
    const row = await moveLibraryFile(
      db,
      scope,
      { type: 'member', id: scope.memberId },
      c.req.param('id'),
      path,
    )
    return c.json(await libraryFileOf(db, row))
  })

  /** To the trash: restorable for TRASH_DAYS days. */
  .delete('/:id', async (c) => {
    const { scope, db } = c.var
    await trashLibraryFile(db, scope, { type: 'member', id: scope.memberId }, c.req.param('id'))
    return c.body(null, 204)
  })
