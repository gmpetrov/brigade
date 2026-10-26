// A thread's files for its computer: the runner fetches them to put in the
// teammates' working folders, and uploads the ones a teammate sends with a
// connector call (an email's attachments, a Drive upload) or a child's report.
// Those go straight from the runner to the bucket through a signed URL, never
// through the API, which reads them back as they stream to check them.
// Authenticated by the runner's token; only threads on its own computer.
//   GET  /runner/attachments/<id>   the file: a redirect to a signed URL with R2
//   POST /runner/attachments/uploads  { sessionId, teammateId?, name, size, sha256, contentType? }
//        → 201 { id, url, method: 'PUT', headers }: PUT the bytes there, then
//   POST /runner/attachments/<id>/complete  { sha256 }  → { id, name, size, contentType }
//   POST /runner/attachments?sessionId&teammateId&name  the bytes as the body (old runners)
import { ATTACHMENT_MAX, RunnerUploadDone, StartRunnerAttachment } from '@brigade/contracts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { finishUpload, startTeammateUpload, storeAttachment } from '../attachments.js'
import { attachmentKey, directUploads, presignGet, streamObject } from '../bucket.js'
import { scoped, type ScopedDb } from '../db.js'
import { authenticateRunner } from '../hub.js'
import { parseBody } from '../scope.js'
import { actingTeammate } from '../thread-spec.js'

type Runner = NonNullable<Awaited<ReturnType<typeof authenticateRunner>>>

/** The thread on the runner's computer a file is for, once that teammate is in it. */
async function threadOf(
  db: ScopedDb,
  runner: Runner,
  sessionId: string,
  teammateId: string | undefined,
) {
  const session = await db.session.findFirst({
    where: { id: sessionId, computerId: runner.computerId },
  })
  if (!session) throw new HTTPException(404, { message: 'Unknown thread' })
  const teammate = await actingTeammate(db, session, teammateId)
  if (!teammate) throw new HTTPException(403, { message: 'That teammate is not in this thread' })
  return session
}

const info = (row: { id: string; name: string; size: number; contentType: string }) => ({
  id: row.id,
  name: row.name,
  size: row.size,
  contentType: row.contentType,
})

export const runnerAttachments = new Hono<{ Variables: { runner: Runner } }>()
  .use(async (c, next) => {
    const runner = await authenticateRunner(c.req.header('authorization'))
    if (!runner) throw new HTTPException(401, { message: 'Unknown runner token' })
    c.set('runner', runner)
    await next()
  })

  .get('/:id', async (c) => {
    const { runner } = c.var
    const db = scoped(runner)
    const onThisComputer = { computerId: runner.computerId }
    const row = await db.attachment.findFirst({
      where: {
        id: c.req.param('id'),
        status: 'ready',
        OR: [{ threads: { some: { session: onThisComputer } } }, { session: onThisComputer }],
      },
    })
    if (!row) throw new HTTPException(404, { message: 'File not found' })
    // From the bucket's short-lived URL, never through the API (fetch drops the token on the
    // way there); the runner checks the bytes against the SHA-256 it was given.
    if (directUploads) {
      const signed = await presignGet(attachmentKey(runner, row.id), {
        contentType: 'application/octet-stream',
        disposition: 'attachment',
      })
      return c.redirect(signed.url, 302)
    }
    // Without R2 (on a laptop): from its folder, as it streams.
    const body = await streamObject(attachmentKey(runner, row.id))
    if (!body) throw new HTTPException(404, { message: 'The file is missing from storage' })
    return c.body(body, 200, {
      'content-type': 'application/octet-stream',
      'x-sha256': row.sha256,
    })
  })

  /**
   * Start the upload of a file a teammate sends: a pending file of its thread, and where to
   * PUT exactly its size. Its SHA-256 is checked once it is in (complete).
   */
  .post('/uploads', async (c) => {
    const { runner } = c.var
    const db = scoped(runner)
    const input = await parseBody(c.req.raw, StartRunnerAttachment)
    const session = await threadOf(db, runner, input.sessionId, input.teammateId)
    const { row, url, headers } = await startTeammateUpload(db, runner, {
      name: input.name,
      size: input.size,
      sessionId: session.id,
      ...(input.contentType ? { contentType: input.contentType } : {}),
    })
    return c.json({ id: row.id, url, method: 'PUT' as const, headers }, 201)
  })

  /**
   * The upload is done: the bytes are read back from the bucket and checked (size, the
   * SHA-256 given, type). One that does not match is removed: 400, upload it again.
   */
  .post('/:id/complete', async (c) => {
    const { runner } = c.var
    const db = scoped(runner)
    const { sha256 } = await parseBody(c.req.raw, RunnerUploadDone)
    const row = await db.attachment.findFirst({
      where: {
        id: c.req.param('id'),
        source: 'teammate',
        session: { computerId: runner.computerId },
      },
      select: { id: true, sessionId: true },
    })
    if (!row?.sessionId) throw new HTTPException(404, { message: 'Upload not found' })
    return c.json(
      info(await finishUpload(db, runner, row.id, { sessionId: row.sessionId }, { sha256 })),
    )
  })

  /**
   * A file a teammate sends with a connector call: ?sessionId&teammateId&name, the bytes as the
   * body, held in the API's memory. Runners before DIRECT_UPLOAD_PROTOCOL only: remove once
   * MIN_PROTOCOL_VERSION reaches it.
   */
  .post('/', async (c) => {
    const { runner } = c.var
    const db = scoped(runner)
    const session = await threadOf(
      db,
      runner,
      c.req.query('sessionId') ?? '',
      c.req.query('teammateId'),
    )
    const name = c.req.query('name') ?? ''
    if (!name) throw new HTTPException(400, { message: 'Name the file' })
    if (Number(c.req.header('content-length') ?? 0) > ATTACHMENT_MAX)
      throw new HTTPException(413, { message: 'Files can be up to 25 MB' })
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    if (bytes.byteLength > ATTACHMENT_MAX)
      throw new HTTPException(413, { message: 'Files can be up to 25 MB' })
    const row = await storeAttachment(db, runner, {
      source: 'teammate',
      sessionId: session.id,
      name,
      bytes,
    })
    return c.json(info(row), 201)
  })
