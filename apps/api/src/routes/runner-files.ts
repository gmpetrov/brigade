// Images a teammate's reply shows, put in its thread's bucket folder by the runner
// (message.images): the bytes go straight from the runner to R2 through a signed URL,
// never through the API's memory, nor its WebSocket or the database. Authenticated by
// the runner's token; only threads on its computer. A thread deleted since is 410 Gone.
//   POST /runner/files/<thread>/<name>/upload  { size }  → a signed PUT URL, or { url: null }
//   PUT  /runner/files/<thread>/<name>   the image, through the API (no R2: development)
// <name> is a stored file's (STORED_FILE_NAME): the image's SHA-256 and its extension.
import { IMAGE_VIEW_MAX, STORED_FILE_NAME } from '@brigade/contracts'
import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { directUploads, presignPut, putObject, threadFileKey } from '../bucket.js'
import { scoped } from '../db.js'
import { authenticateRunner } from '../hub.js'
import { contentTypeFor } from '../library.js'
import { parseBody } from '../scope.js'

const Size = z.object({ size: z.number().int().positive().max(IMAGE_VIEW_MAX) })

type Runner = NonNullable<Awaited<ReturnType<typeof authenticateRunner>>>

/** The bucket key a request names, once its thread is on the runner's computer. */
async function fileOf(c: Context<{ Variables: { runner: Runner } }>) {
  const { runner } = c.var
  const sessionId = c.req.param('sessionId')!
  const name = c.req.param('name')!
  // Images only: a PDF is not something a reply shows.
  if (!STORED_FILE_NAME.test(name) || name.endsWith('.pdf'))
    throw new HTTPException(400, { message: 'Which image?' })
  const thread = await scoped(runner).session.findFirst({
    where: { id: sessionId },
    select: { computerId: true },
  })
  // Deleted: the runner gives up on it.
  if (!thread) throw new HTTPException(410, { message: 'Thread deleted' })
  if (thread.computerId !== runner.computerId)
    throw new HTTPException(404, { message: 'Unknown thread' })
  return { key: threadFileKey(runner, sessionId, name), type: contentTypeFor(name) }
}

export const runnerFiles = new Hono<{ Variables: { runner: Runner } }>()
  .use(async (c, next) => {
    const runner = await authenticateRunner(c.req.header('authorization'))
    if (!runner) throw new HTTPException(401, { message: 'Unknown runner token' })
    c.set('runner', runner)
    await next()
  })

  /** Where to upload an image of this size: a signed URL of the bucket, or null for the API itself. */
  .post('/:sessionId/:name/upload', async (c) => {
    const { key, type } = await fileOf(c)
    const { size } = await parseBody(c.req.raw, Size)
    if (!directUploads) return c.json({ url: null })
    return c.json(await presignPut(key, size, type))
  })

  .put('/:sessionId/:name', async (c) => {
    if (directUploads) throw new HTTPException(400, { message: 'Upload to the signed URL' })
    const { key, type } = await fileOf(c)
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    if (bytes.byteLength === 0 || bytes.byteLength > IMAGE_VIEW_MAX)
      throw new HTTPException(413, { message: 'Too large' })
    await putObject(key, bytes, type)
    return c.json({ ok: true })
  })
