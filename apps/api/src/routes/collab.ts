// The collab server's calls (apps/collab): a document's room asks for the
// stored text as Yjs, and saves what people edited. Authenticated by the
// shared COLLAB_SECRET; each call names one document, whose workspace scopes
// everything that follows.
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { fromCollabServer, normalizeMarkdown, toMarkdown, updateFrom } from '../collab.js'
import { prisma, scoped } from '../db.js'
import { documentText, isMarkdown, saveDocumentText } from '../library.js'

const SHA = 'x-collab-sha'

async function document(id: string) {
  const row = await prisma.document.findUnique({ where: { id } })
  if (!row || !isMarkdown(row)) throw new HTTPException(404, { message: 'Document not found' })
  const scope = { organizationId: row.organizationId, workspaceId: row.workspaceId }
  return { row, scope, db: scoped(scope) }
}

const body = async (request: Request) => new Uint8Array(await request.arrayBuffer())

const binary = (update: Uint8Array, sha: string) =>
  new Response(update as Uint8Array<ArrayBuffer>, {
    headers: { 'content-type': 'application/octet-stream', [SHA]: sha },
  })

export const collab = new Hono()
  .use(async (c, next) => {
    if (!fromCollabServer(c.req.header('authorization')))
      throw new HTTPException(401, { message: 'Unknown collab server' })
    await next()
  })

  /**
   * Bring a room up to date. The body is the room's state when it last
   * matched the stored text (`x-collab-sha`), empty on first load. Nothing
   * when that is still the stored text; otherwise the update from there to
   * now, which the room merges into what people are editing.
   */
  .post('/documents/:id/reconcile', async (c) => {
    const { row, scope } = await document(c.req.param('id'))
    if (c.req.header(SHA) === row.sha256) return c.body(null, 204)
    const update = await updateFrom(await body(c.req.raw), await documentText(scope, row))
    return binary(update, row.sha256)
  })

  /**
   * Save what people edited. The body is the room's state; `x-collab-sha` the
   * stored text it builds on; `x-collab-editors` the members who changed it.
   * 409 when the text changed since (a teammate wrote to it): reconcile first.
   */
  .put('/documents/:id', async (c) => {
    const { row, scope, db } = await document(c.req.param('id'))
    if (c.req.header(SHA) !== row.sha256) return c.json({ error: 'stale' }, 409)
    const text = await toMarkdown(await body(c.req.raw))
    // Opening a file reformats it (list markers, table padding): not an edit.
    if (text === (await normalizeMarkdown(await documentText(scope, row))))
      return c.json({ sha: row.sha256, saved: false })
    const editors = (c.req.header('x-collab-editors') ?? '').split(',').filter(Boolean)
    const member = editors[0]
      ? await db.member.findFirst({ where: { id: editors[0] }, select: { id: true } })
      : null
    const saved = await saveDocumentText(
      db,
      scope,
      member ? { type: 'member', id: member.id } : { type: 'system', id: 'collab' },
      row,
      text,
      { fromCollab: true },
    )
    return c.json({ sha: saved.sha256, saved: true })
  })
