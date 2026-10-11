// The library and memory, from the dashboard. Any member may upload, read,
// edit and correct; every change is audited and synced to the computers.
import {
  CreateLibraryText,
  EditTarget,
  LibraryPath,
  MoveLibraryFile,
  WriteLibraryText,
  WriteMemory,
  type EditSession,
  type MemoryFile,
  type MemoryOverview,
} from '@brigade/contracts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { collabEnabled, COLLAB_PARTY, cursorColor, editToken } from '../collab.js'
import { env } from '../config.js'
import { prisma } from '../db.js'
import {
  deleteLibraryFile,
  documentText,
  ensureMemory,
  isMarkdown,
  libraryFile,
  memoryHeader,
  moveLibraryFile,
  readLibraryFile,
  readMemory,
  saveDocumentText,
  saveLibraryFile,
  search,
  toLibraryFile,
  writeMemory,
} from '../library.js'
import { parseBody, requireUser, requireWorkspace, type AppEnv } from '../scope.js'

/** Types the browser may show inline from the API's origin; anything else downloads. */
const INLINE =
  /^(text\/plain|text\/markdown|text\/csv|application\/json|application\/pdf|image\/(png|jpeg|gif|webp))$/

const memoryFile = (
  kind: MemoryFile['kind'],
  row: { text: string; updatedAt: Date } | null,
  header: string,
): MemoryFile => ({
  kind,
  text: row?.text ?? header,
  updatedAt: row?.updatedAt.toISOString() ?? null,
})

export const library = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)

  .get('/', async (c) => {
    const rows = await c.var.db.document.findMany({
      where: { kind: 'library' },
      orderBy: { path: 'asc' },
    })
    return c.json(rows.map(toLibraryFile))
  })

  /** Upload one file (multipart: `file`, and `path` to put it somewhere other than its name). */
  .post('/upload', async (c) => {
    const { scope, db } = c.var
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
    return c.json(toLibraryFile(row), 201)
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
    return c.json(toLibraryFile(row), 201)
  })

  /** Full-text search over the library, memory and thread summaries. */
  .get('/search', async (c) => {
    const query = (c.req.query('q') ?? '').trim().slice(0, 500)
    if (!query) return c.json([])
    return c.json(await search(c.var.scope, { query, limit: 30, memberId: c.var.scope.memberId }))
  })

  .get('/memory', async (c) => {
    const { db, scope } = c.var
    const [workspace, teammates, memories, summaries] = await Promise.all([
      readMemory(db, { kind: 'workspace_memory' }),
      db.teammate.findMany({ where: { archivedAt: null }, orderBy: { createdAt: 'asc' } }),
      db.document.findMany({ where: { kind: 'teammate_memory' } }),
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
    const overview: MemoryOverview = {
      workspace: memoryFile(
        'workspace_memory',
        workspace,
        memoryHeader({ kind: 'workspace_memory' }),
      ),
      teammates: teammates.map((t) => ({
        teammateId: t.id,
        name: t.name,
        memory: memoryFile(
          'teammate_memory',
          memories.find((m) => m.teammateId === t.id) ?? null,
          memoryHeader({ kind: 'teammate_memory', teammateId: t.id }, t.name),
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
    const row = await db.document.findFirst({ where: { id: c.req.param('documentId') } })
    if (!row || !isMarkdown(row)) throw new HTTPException(404, { message: 'Document not found' })
    const { text } = await parseBody(c.req.raw, WriteLibraryText)
    await saveDocumentText(db, scope, { type: 'member', id: scope.memberId }, row, text)
    return c.json({ ok: true })
  })

  /** The file's bytes. Shown inline only for types that cannot run script on this origin. */
  .get('/:id/content', async (c) => {
    const row = await libraryFile(c.var.db, c.req.param('id'))
    const bytes = await readLibraryFile(c.var.scope, row.id)
    const inline = c.req.query('download') === undefined && INLINE.test(row.contentType)
    const name = row.path.split('/').pop()!
    return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
      'content-type': row.contentType.startsWith('text/')
        ? `${row.contentType}; charset=utf-8`
        : row.contentType,
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': 'sandbox',
      'cache-control': 'private, no-cache',
    })
  })

  /** Replace a text file's contents. */
  .put('/:id/text', async (c) => {
    const { scope, db } = c.var
    const row = await libraryFile(db, c.req.param('id'))
    if (!toLibraryFile(row).editable)
      throw new HTTPException(400, { message: 'Only text files can be edited here' })
    const { text } = await parseBody(c.req.raw, WriteLibraryText)
    const saved = await saveLibraryFile(
      db,
      scope,
      { type: 'member', id: scope.memberId },
      { path: row.path, bytes: new TextEncoder().encode(text), contentType: row.contentType },
    )
    return c.json(toLibraryFile(saved))
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
    return c.json(toLibraryFile(row))
  })

  .delete('/:id', async (c) => {
    const { scope, db } = c.var
    await deleteLibraryFile(db, scope, { type: 'member', id: scope.memberId }, c.req.param('id'))
    return c.body(null, 204)
  })
