// The Inbox (src/inbox.ts): the list across sources, one item, done, handed to a teammate, its
// thread asked to reply, a person's own reply.
import { HandInboxItem, InboxQuery, ReplyInboxItem, SetInboxDone } from '@brigade/contracts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { attachmentKey, directUploads, presignGet, streamObject } from '../bucket.js'
import {
  askedToReply,
  handItem,
  listInbox,
  openFile,
  parseCursor,
  readItem,
  replyItem,
  setDone,
  waitingCount,
} from '../inbox.js'
import { listMailboxes, readMailbox } from '../mailboxes.js'
import { INLINE } from './attachments.js'
import { parseBody, requireUser, requireWorkspace, type AppEnv } from '../scope.js'

export const inbox = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)

  /** ?source=&teammate=&project=&status=waiting|handled|done|all&q=&before= */
  .get('/', async (c) => {
    const query = InboxQuery.safeParse(c.req.query())
    if (!query.success) throw new HTTPException(400, { message: 'Bad filters' })
    const q = query.data
    const before = q.before ? parseCursor(q.before) : null
    if (q.before && !before) throw new HTTPException(400, { message: 'Bad page' })
    return c.json(
      await listInbox(c.var.db, c.var.scope, {
        ...(q.source ? { source: q.source } : {}),
        ...(q.teammate ? { teammateId: q.teammate } : {}),
        ...(q.project ? { projectId: q.project } : {}),
        status: q.status ?? 'waiting',
        ...(q.q ? { q: q.q } : {}),
        ...(before ? { before } : {}),
      }),
    )
  })

  /** Every mailbox, and one whole (Inbox › Mailboxes). */
  .get('/mailboxes', async (c) => c.json(await listMailboxes(c.var.db, c.var.scope)))
  .get('/mailboxes/:id', async (c) =>
    c.json(await readMailbox(c.var.db, c.var.scope, c.req.param('id'))),
  )

  /** What waits on a person, counted beside Inbox in the sidebar. */
  .get('/count', async (c) => c.json({ waiting: await waitingCount(c.var.db, c.var.scope) }))

  .get('/items/:id', async (c) => c.json(await readItem(c.var.db, c.var.scope, c.req.param('id'))))

  /**
   * A received mail's file: from a short-lived link (Resend's, or the bucket's for Gmail's, copied
   * there once), so its bytes never pass through the API.
   */
  .get('/items/:id/files/:fileId', async (c) => {
    const { db, scope } = c.var
    const opened = await openFile(db, scope, c.req.param('id'), c.req.param('fileId'))
    if ('link' in opened) {
      c.header('cache-control', 'private, no-store')
      return c.redirect(opened.link, 302)
    }
    const row = opened.attachment
    const disposition = `${INLINE.test(row.contentType) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.name)}`
    const key = attachmentKey(scope, row.id)
    if (directUploads) {
      const signed = await presignGet(key, { contentType: row.contentType, disposition })
      c.header('cache-control', `private, max-age=${signed.seconds - 60}`)
      return c.redirect(signed.url, 302)
    }
    // Without R2 (on a laptop): from its folder, as it streams.
    const stream = await streamObject(key)
    if (!stream) throw new HTTPException(404, { message: 'The file is missing from storage' })
    return c.body(stream, 200, {
      'content-type': row.contentType,
      'content-disposition': disposition,
      'x-content-type-options': 'nosniff',
      'content-security-policy': 'sandbox',
    })
  })

  .post('/items/:id/done', async (c) => {
    const { done } = await parseBody(c.req.raw, SetInboxDone)
    await setDone(c.var.db, c.var.scope, c.req.param('id'), done)
    return c.json({ ok: true })
  })

  /** A person asked its thread to reply after all, in the thread: no longer To do for what it chose. */
  .post('/items/:id/asked', async (c) => {
    await askedToReply(c.var.db, c.var.scope, c.req.param('id'))
    return c.json({ ok: true })
  })

  /** A person's own reply, from its mailbox (Reply myself). */
  .post('/items/:id/reply', async (c) => {
    const { text } = await parseBody(c.req.raw, ReplyInboxItem)
    return c.json(await replyItem(c.var.db, c.var.scope, c.req.param('id'), text), 201)
  })

  .post('/items/:id/hand', async (c) => {
    const input = await parseBody(c.req.raw, HandInboxItem)
    return c.json(
      await handItem(c.var.db, c.var.scope, c.req.param('id'), {
        teammateId: input.teammateId,
        ...(input.note ? { note: input.note } : {}),
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      }),
      201,
    )
  })
