// Files for threads, from the dashboard: a member uploads them while writing a
// message, then sends their ids with it. With R2 the browser sends the bytes
// straight to the bucket (POST /uploads, PUT, POST /:id/complete); without it
// they come through the API (POST /). Any member who can see a thread can see
// its files; an unsent upload only its uploader.
import { ATTACHMENT_MAX, StartUpload, type UploadTicket } from '@brigade/contracts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { audit } from '../audit.js'
import {
  deleteAttachment,
  finishUpload,
  servedFromBucket,
  startUpload,
  storeAttachment,
  toInfo,
} from '../attachments.js'
import { attachmentKey, directUploads, presignGet } from '../bucket.js'
import { parseBody, requireUser, requireWorkspace, type AppEnv } from '../scope.js'
import { serveObject } from '../serve-object.js'

/** Types the browser may show inline from the API's origin; anything else downloads. */
export const INLINE =
  /^(text\/plain|text\/markdown|text\/csv|application\/json|application\/pdf|image\/(png|jpeg|gif|webp)|video\/(mp4|webm|quicktime)|audio\/(mpeg|mp4|wav|ogg|webm))$/

export const attachments = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)

  /**
   * Start an upload: a signed URL of the bucket for the browser to PUT the
   * bytes to, or { direct: false } to upload through the API instead.
   */
  .post('/uploads', async (c) => {
    const { scope, db } = c.var
    const input = await parseBody(c.req.raw, StartUpload)
    if (!directUploads) return c.json({ direct: false } satisfies UploadTicket)
    const { row, url, headers } = await startUpload(db, scope, {
      ...input,
      memberId: scope.memberId,
    })
    return c.json(
      { direct: true, attachment: toInfo(row), url, method: 'PUT', headers } satisfies UploadTicket,
      201,
    )
  })

  /** The browser's upload reached the bucket: the file is checked, then ready to send. */
  .post('/:id/complete', async (c) => {
    const { scope, db } = c.var
    const row = await finishUpload(db, scope, c.req.param('id'), { memberId: scope.memberId })
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'attachment.uploaded',
      target: { type: 'attachment', id: row.id },
      data: { name: row.name, size: row.size, direct: true },
    })
    return c.json(toInfo(row))
  })

  /** Upload one file through the API (multipart: `file`), when the bucket takes no direct uploads. */
  .post('/', async (c) => {
    const { scope, db } = c.var
    const declared = Number(c.req.header('content-length') ?? 0)
    if (declared > ATTACHMENT_MAX + 64 * 1024)
      throw new HTTPException(413, { message: 'Files can be up to 25 MB' })
    const form = await c.req.parseBody()
    const file = form.file
    if (!(file instanceof File)) throw new HTTPException(400, { message: 'Attach a file' })
    if (file.size > ATTACHMENT_MAX)
      throw new HTTPException(413, { message: 'Files can be up to 25 MB' })
    const row = await storeAttachment(db, scope, {
      source: 'upload',
      uploadedByMemberId: scope.memberId,
      name: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
      contentType: file.type,
    })
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'attachment.uploaded',
      target: { type: 'attachment', id: row.id },
      data: { name: row.name, size: row.size },
    })
    return c.json(toInfo(row), 201)
  })

  /** The file's bytes. Shown inline only for types that cannot run script on this origin. */
  .get('/:id/content', async (c) => {
    const { scope, db } = c.var
    const row = await db.attachment.findFirst({
      where: {
        id: c.req.param('id'),
        status: 'ready',
        OR: [
          { threads: { some: {} } },
          { sessionId: { not: null } },
          { uploadedByMemberId: scope.memberId },
        ],
      },
    })
    if (!row) throw new HTTPException(404, { message: 'File not found' })
    const inline = c.req.query('download') === undefined && INLINE.test(row.contentType)
    if (servedFromBucket(row)) {
      // A large video: from the bucket's short-lived URL, which answers ranges itself.
      const signed = await presignGet(attachmentKey(scope, row.id), {
        contentType: row.contentType,
        disposition: `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.name)}`,
      })
      // The signed URL works a little longer than the browser keeps this.
      c.header('cache-control', `private, max-age=${signed.seconds - 60}`)
      return c.redirect(signed.url, 302)
    }
    // Through the API (the dashboard reads it with its session), as it streams.
    return serveObject(c, attachmentKey(scope, row.id), {
      'content-type': row.contentType.startsWith('text/')
        ? `${row.contentType}; charset=utf-8`
        : row.contentType,
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.name)}`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': 'sandbox',
      'cache-control': 'private, max-age=3600',
    })
  })

  /** Remove an upload that was not sent: the chip's ✕ in the composer. */
  .delete('/:id', async (c) => {
    const { scope, db } = c.var
    const row = await db.attachment.findFirst({
      where: {
        id: c.req.param('id'),
        source: 'upload',
        uploadedByMemberId: scope.memberId,
        threads: { none: {} },
      },
    })
    if (!row) throw new HTTPException(404, { message: 'File not found or already sent' })
    await deleteAttachment(db, scope, { type: 'member', id: scope.memberId }, row.id)
    return c.body(null, 204)
  })
