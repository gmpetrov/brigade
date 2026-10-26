// Files a teammate saves to the library or proposes as a skill's, uploaded by its runner
// straight to the bucket (uploads.ts): its library.call then names the upload, never
// carrying the bytes over the socket. Authenticated by the runner's token; only threads on
// its computer, and teammates in them.
//   POST /runner/uploads               { purpose, sessionId, teammateId, name, size, sha256 }  → where to PUT them
//   POST /runner/uploads/:id/complete  → checked against the SHA-256; a skill's file is then kept
import { StartRunnerUpload } from '@brigade/contracts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { skillFileKey } from '../bucket.js'
import { scoped } from '../db.js'
import { authenticateRunner } from '../hub.js'
import { parseBody } from '../scope.js'
import { actingTeammate } from '../thread-spec.js'
import {
  completeFileUpload,
  copyUpload,
  discardUpload,
  startFileUpload,
  toUploadInfo,
} from '../uploads.js'

type Runner = NonNullable<Awaited<ReturnType<typeof authenticateRunner>>>

export const runnerUploads = new Hono<{ Variables: { runner: Runner } }>()
  .use(async (c, next) => {
    const runner = await authenticateRunner(c.req.header('authorization'))
    if (!runner) throw new HTTPException(401, { message: 'Unknown runner token' })
    c.set('runner', runner)
    await next()
  })

  .post('/', async (c) => {
    const { runner } = c.var
    const db = scoped(runner)
    const input = await parseBody(c.req.raw, StartRunnerUpload)
    const session = await db.session.findFirst({
      where: { id: input.sessionId, computerId: runner.computerId },
    })
    if (!session) throw new HTTPException(404, { message: 'Unknown thread' })
    const teammate = await actingTeammate(db, session, input.teammateId)
    if (!teammate) throw new HTTPException(403, { message: 'That teammate is not in this thread' })
    const owner = { computerId: runner.computerId, sessionId: session.id, teammateId: teammate.id }
    return c.json(await startFileUpload(db, runner, owner, input), 201)
  })

  .post('/:id/complete', async (c) => {
    const { runner } = c.var
    const db = scoped(runner)
    const pending = await db.upload.findFirst({
      where: { id: c.req.param('id'), computerId: runner.computerId },
      select: { sessionId: true },
    })
    if (!pending?.sessionId) throw new HTTPException(404, { message: 'Upload not found' })
    const owner = { computerId: runner.computerId, sessionId: pending.sessionId }
    const row = await completeFileUpload(db, runner, owner, c.req.param('id'))
    if (row.purpose === 'skill_file') {
      // Kept by its SHA-256, as every skill's file is; the proposal names it so (`refs`).
      await copyUpload(runner, row, skillFileKey(runner, row.sha256), 'application/octet-stream')
      await discardUpload(runner, row.id)
    }
    return c.json(toUploadInfo(row))
  })
