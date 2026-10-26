// Images and PDFs of a thread, put in its bucket folder by the runner: those a teammate's
// reply shows (message.images) and those its events carry (STORED_FILE: a screenshot it
// read, a PDF it captured). The bytes go straight from the runner to R2 through a signed
// URL, never through the API's memory, nor its WebSocket or the database; the API then
// reads them back as they stream to check them. Authenticated by the runner's token; only
// threads on its computer. A thread deleted since is 410 Gone.
//   POST /runner/files/<thread>/<name>/upload    { size }  → a signed PUT URL, or { url: null }
//   PUT  /runner/files/<thread>/<name>   the file, through the API (no R2: development)
//   POST /runner/files/<thread>/<name>/complete  { size }  → checked in the bucket: its size,
//        that its SHA-256 is its name's and its leading bytes its extension's; else removed, 400
// <name> is a stored file's (STORED_FILE_NAME): the file's SHA-256 and its extension.
import { createHash } from 'node:crypto'
import { STORED_FILE_NAME, THREAD_FILE_MAX } from '@brigade/contracts'
import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import {
  deleteObject,
  directUploads,
  presignPut,
  putObject,
  streamObject,
  threadFileKey,
} from '../bucket.js'
import { scoped } from '../db.js'
import { authenticateRunner } from '../hub.js'
import { contentTypeFor } from '../library.js'
import { MAGIC } from '../object-check.js'
import { parseBody } from '../scope.js'

const Size = z.object({ size: z.number().int().positive().max(THREAD_FILE_MAX) })

type Runner = NonNullable<Awaited<ReturnType<typeof authenticateRunner>>>

/** The bucket key a request names, once its thread is on the runner's computer. */
async function fileOf(c: Context<{ Variables: { runner: Runner } }>) {
  const { runner } = c.var
  const sessionId = c.req.param('sessionId')!
  const name = c.req.param('name')!
  if (!STORED_FILE_NAME.test(name)) throw new HTTPException(400, { message: 'Which file?' })
  const thread = await scoped(runner).session.findFirst({
    where: { id: sessionId },
    select: { computerId: true },
  })
  // Deleted: the runner gives up on it.
  if (!thread) throw new HTTPException(410, { message: 'Thread deleted' })
  if (thread.computerId !== runner.computerId)
    throw new HTTPException(404, { message: 'Unknown thread' })
  return { key: threadFileKey(runner, sessionId, name), name, type: contentTypeFor(name) }
}

/**
 * The object's size and SHA-256, read as it streams (never held whole), and its leading bytes.
 * Stops once more than `max` bytes came. Null when it is not in the bucket.
 */
async function readBack(key: string, max: number) {
  const stream = await streamObject(key)
  if (!stream) return null
  const hash = createHash('sha256')
  const head = new Uint8Array(16)
  let size = 0
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    if (size < head.length) head.set(chunk.subarray(0, head.length - size), size)
    size += chunk.byteLength
    if (size > max) {
      await stream.cancel().catch(() => undefined)
      break
    }
    hash.update(chunk)
  }
  return { size, sha256: hash.digest('hex'), head: head.subarray(0, Math.min(size, head.length)) }
}

export const runnerFiles = new Hono<{ Variables: { runner: Runner } }>()
  .use(async (c, next) => {
    const runner = await authenticateRunner(c.req.header('authorization'))
    if (!runner) throw new HTTPException(401, { message: 'Unknown runner token' })
    c.set('runner', runner)
    await next()
  })

  /** Where to upload a file of this size: a signed URL of the bucket, or null for the API itself. */
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
    if (bytes.byteLength === 0 || bytes.byteLength > THREAD_FILE_MAX)
      throw new HTTPException(413, { message: 'Too large' })
    await putObject(key, bytes, type)
    return c.json({ ok: true })
  })

  /**
   * The upload is done: the file in the bucket is the one its name says, whole. One that is
   * not (another size, other bytes, not the type of its extension) is removed: the dashboard
   * shows it inline from its name.
   */
  .post('/:sessionId/:name/complete', async (c) => {
    const { key, name, type } = await fileOf(c)
    const { size } = await parseBody(c.req.raw, Size)
    const read = await readBack(key, size)
    if (!read)
      throw new HTTPException(409, { message: 'The file has not reached storage; upload it again' })
    const check = MAGIC[type]
    if (
      read.size !== size ||
      read.sha256 !== name.slice(0, name.indexOf('.')) ||
      !check ||
      !check(read.head)
    ) {
      await deleteObject(key)
      throw new HTTPException(400, {
        message: 'The upload does not match the file; upload it again',
      })
    }
    return c.json({ ok: true })
  })
