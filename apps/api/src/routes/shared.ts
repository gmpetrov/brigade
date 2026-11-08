// Library files behind their public links (src/library-shares.ts, docs/public-links.md): read by
// anyone with the link, without a session. Each answer is the file as it is now, never cached, and
// kept out of search engines. A design's page itself is on the sandbox origin (designs.ts).
import { LIBRARY_READ_MAX } from '@brigade/contracts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { serveAsset } from '../assets.js'
import { designTitle } from '../designs.js'
import { readLibraryFile } from '../library.js'
import { fileKey } from '../library-objects.js'
import { sharedOr404, sharedView, shareKind, sharesAsset } from '../library-shares.js'
import { libraryPreview } from '../previews.js'
import { fileResponse } from './library.js'

const NOT_FOUND = 'This link is off or no longer exists'

export const shared = new Hono()
  .use(async (c, next) => {
    await next()
    c.header('x-robots-tag', 'noindex, nofollow')
    c.header('referrer-policy', 'no-referrer')
  })

  /** What the link shows: the page at <web>/s/<token> reads it. */
  .get('/:token', async (c) => {
    const view = await sharedView(await sharedOr404(c.req.param('token')), designTitle)
    c.header('cache-control', 'no-store')
    return c.json(view)
  })

  /**
   * A shared file's bytes, to show or download (`?download`). Not a document's, whose link
   * publishes only its prepared text (publishedText), nor a design's, on the sandbox origin.
   */
  .get('/:token/content', async (c) => {
    const shared = await sharedOr404(c.req.param('token'))
    if (shareKind(shared.document).kind !== 'file')
      throw new HTTPException(404, { message: NOT_FOUND })
    const row = shared.document
    const response = await fileResponse(
      c,
      fileKey(shared.scope, row),
      row,
      c.req.query('download') !== undefined,
    )
    // To the bucket's short-lived address: asked again each time, so a link turned off stops.
    if (response.status === 302) response.headers.set('cache-control', 'no-store')
    return response
  })

  /** A shared Word document, spreadsheet or deck, as the API reads it. */
  .get('/:token/preview', async (c) => {
    const shared = await sharedOr404(c.req.param('token'))
    const row = shared.document
    if (shareKind(row).kind !== 'file') throw new HTTPException(404, { message: NOT_FOUND })
    if (row.size > LIBRARY_READ_MAX)
      throw new HTTPException(413, { message: 'The file is too large to preview' })
    c.header('cache-control', 'no-store')
    return c.json(await libraryPreview(await readLibraryFile(shared.scope, row), row.contentType))
  })

  /** A file uploaded into the shared document, which it refers to: an image, a video, a PDF. */
  .get('/:token/assets/:id', async (c) => {
    const shared = await sharedOr404(c.req.param('token'))
    const id = c.req.param('id')
    if (!(await sharesAsset(shared, id)))
      throw new HTTPException(404, { message: 'File not found' })
    const served = await serveAsset(
      shared.db,
      shared.scope,
      id,
      c.req.query('download') !== undefined,
    )
    if ('redirect' in served) {
      // Asked again each time: once the link is off, no browser keeps the way to the file.
      c.header('cache-control', 'no-store')
      return c.redirect(served.redirect.url, 302)
    }
    return c.body(served.bytes as Uint8Array<ArrayBuffer>, 200, {
      'content-type': served.row.contentType,
      'content-disposition': served.disposition,
      'x-content-type-options': 'nosniff',
      'content-security-policy': 'sandbox',
      'cache-control': 'no-store',
    })
  })
