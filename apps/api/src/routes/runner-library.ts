// What a runner mirrors: the library's files and the memory teammates load.
// Authenticated by the runner's token; scoped to its own workspace.
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { scoped } from '../db.js'
import { authenticateRunner } from '../hub.js'
import { directUploads, presignGet, streamObject } from '../bucket.js'
import { libraryFile, manifest } from '../library.js'
import { fileKey } from '../library-objects.js'

export const runnerLibrary = new Hono<{
  Variables: { runner: NonNullable<Awaited<ReturnType<typeof authenticateRunner>>> }
}>()
  .use(async (c, next) => {
    const runner = await authenticateRunner(c.req.header('authorization'))
    if (!runner) throw new HTTPException(401, { message: 'Unknown runner token' })
    c.set('runner', runner)
    await next()
  })

  .get('/', async (c) => c.json(await manifest(scoped(c.var.runner), c.var.runner)))

  /**
   * A file's bytes, as they stream: a file can be hundreds of MB. From the bucket's short-lived
   * URL when there is one (fetch drops the token on the way there); the runner checks the bytes
   * against the file's SHA-256 in the manifest.
   */
  .get('/files/:id', async (c) => {
    const { runner } = c.var
    const row = await libraryFile(scoped(runner), c.req.param('id'))
    const key = fileKey(runner, row)
    if (directUploads) {
      const signed = await presignGet(key, {
        contentType: 'application/octet-stream',
        disposition: 'attachment',
      })
      return c.redirect(signed.url, 302)
    }
    const body = await streamObject(key)
    if (!body) throw new HTTPException(404, { message: 'The file is missing from storage' })
    return c.body(body, 200, {
      'content-type': 'application/octet-stream',
      'x-sha256': row.sha256,
    })
  })
