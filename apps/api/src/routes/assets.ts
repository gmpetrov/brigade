// Files put in documents from the dashboard's editor (assets.ts). Any member
// may add files to a document they can edit, and read any document's files.
import { ASSET_MAX_THROUGH_API, StartAssetUpload, type AssetTicket } from '@brigade/contracts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { finishAssetUpload, serveAsset, startAssetUpload, storeAsset, toAsset } from '../assets.js'
import { directUploads } from '../bucket.js'
import { parseBody, requireUser, requireWorkspace, type AppEnv } from '../scope.js'

export const documentAssets = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)

  /** Start an upload: a signed bucket URL to PUT to, or { direct: false } to POST it here. */
  .post('/uploads', async (c) => {
    const { scope, db } = c.var
    const input = await parseBody(c.req.raw, StartAssetUpload)
    if (!directUploads) return c.json({ direct: false } satisfies AssetTicket)
    const { row, url, headers } = await startAssetUpload(db, scope, {
      ...input,
      memberId: scope.memberId,
    })
    return c.json(
      { direct: true, asset: toAsset(row), url, method: 'PUT', headers } satisfies AssetTicket,
      201,
    )
  })

  /** The browser's upload reached the bucket. */
  .post('/:id/complete', async (c) => {
    const { scope, db } = c.var
    return c.json(toAsset(await finishAssetUpload(db, scope, c.req.param('id'), scope.memberId)))
  })

  /** One file through the API (multipart: `file`, `documentId`), without direct uploads. */
  .post('/', async (c) => {
    const { scope, db } = c.var
    if (Number(c.req.header('content-length') ?? 0) > ASSET_MAX_THROUGH_API + 64 * 1024)
      throw new HTTPException(413, { message: 'Files can be up to 25 MB here' })
    const form = await c.req.parseBody()
    if (!(form.file instanceof File)) throw new HTTPException(400, { message: 'Attach a file' })
    if (typeof form.documentId !== 'string')
      throw new HTTPException(400, { message: 'Say which document it is for' })
    const row = await storeAsset(db, scope, {
      documentId: form.documentId,
      file: form.file,
      memberId: scope.memberId,
    })
    return c.json(toAsset(row), 201)
  })

  /** The file: a redirect to a short-lived bucket URL, or the bytes without R2. */
  .get('/:id', async (c) => {
    const { scope, db } = c.var
    const served = await serveAsset(
      db,
      scope,
      c.req.param('id'),
      c.req.query('download') !== undefined,
    )
    if ('redirect' in served) {
      // The signed URL works a little longer than the browser keeps this.
      c.header('cache-control', `private, max-age=${served.redirect.seconds - 60}`)
      return c.redirect(served.redirect.url, 302)
    }
    return c.body(served.bytes as Uint8Array<ArrayBuffer>, 200, {
      'content-type': served.row.contentType,
      'content-disposition': served.disposition,
      'x-content-type-options': 'nosniff',
      'content-security-policy': 'sandbox',
      'cache-control': 'private, max-age=3600',
    })
  })
