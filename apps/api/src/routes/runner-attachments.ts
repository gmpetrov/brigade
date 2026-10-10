// A thread's files for its computer: the runner fetches them to put in the
// teammates' working folders, and uploads the ones a teammate sends with a
// connector call (an email's attachments). Authenticated by the runner's token;
// only threads on its own computer.
import { ATTACHMENT_MAX } from '@brigade/contracts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { readAttachment, storeAttachment } from '../attachments.js'
import { scoped } from '../db.js'
import { authenticateRunner } from '../hub.js'
import { actingTeammate } from '../thread-spec.js'

export const runnerAttachments = new Hono<{
  Variables: { runner: NonNullable<Awaited<ReturnType<typeof authenticateRunner>>> }
}>()
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
    const bytes = await readAttachment(runner, row.id)
    return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
      'content-type': 'application/octet-stream',
      'x-sha256': row.sha256,
    })
  })

  /** A file a teammate sends with a connector call: ?sessionId&teammateId&name, the bytes as the body. */
  .post('/', async (c) => {
    const { runner } = c.var
    const db = scoped(runner)
    const session = await db.session.findFirst({
      where: { id: c.req.query('sessionId') ?? '', computerId: runner.computerId },
    })
    if (!session) throw new HTTPException(404, { message: 'Unknown thread' })
    const teammate = await actingTeammate(db, session, c.req.query('teammateId'))
    if (!teammate) throw new HTTPException(403, { message: 'That teammate is not in this thread' })
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
    return c.json({ id: row.id, name: row.name, size: row.size, contentType: row.contentType }, 201)
  })
