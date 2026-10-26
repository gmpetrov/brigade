// Files a member uploads straight to the bucket, to use by their id: a library file, the
// design canvas's picture, a skill pack to import, a logo (uploads.ts). The bytes never
// come through the API.
//   POST   /api/uploads                { purpose, name, size, contentType }  → where to PUT them
//   POST   /api/uploads/:id/complete   → checked: ready to use
//   DELETE /api/uploads/:id            → abandoned
import { StartFileUpload } from '@brigade/contracts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { parseBody, requireUser, requireWorkspace, type AppEnv } from '../scope.js'
import { completeFileUpload, discardUpload, startFileUpload, toUploadInfo } from '../uploads.js'

export const uploads = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)

  .post('/', async (c) => {
    const { scope, db } = c.var
    const input = await parseBody(c.req.raw, StartFileUpload)
    // Read as an import: an admin's (routes/skills.ts).
    if (input.purpose === 'skill_file')
      throw new HTTPException(400, { message: 'A skill file comes with a skill' })
    return c.json(await startFileUpload(db, scope, { memberId: scope.memberId }, input), 201)
  })

  .post('/:id/complete', async (c) => {
    const { scope, db } = c.var
    const row = await completeFileUpload(db, scope, { memberId: scope.memberId }, c.req.param('id'))
    return c.json(toUploadInfo(row))
  })

  .delete('/:id', async (c) => {
    const { scope, db } = c.var
    const row = await db.upload.findFirst({
      where: { id: c.req.param('id'), memberId: scope.memberId },
    })
    if (!row) throw new HTTPException(404, { message: 'Upload not found' })
    await discardUpload(scope, row.id)
    return c.body(null, 204)
  })
