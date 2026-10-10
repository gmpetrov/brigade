// What a runner mirrors: the library's files and the memory teammates load.
// Authenticated by the runner's token; scoped to its own workspace.
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { scoped } from '../db.js'
import { authenticateRunner } from '../hub.js'
import { libraryFile, manifest, readLibraryFile } from '../library.js'

export const runnerLibrary = new Hono<{
  Variables: { runner: NonNullable<Awaited<ReturnType<typeof authenticateRunner>>> }
}>()
  .use(async (c, next) => {
    const runner = await authenticateRunner(c.req.header('authorization'))
    if (!runner) throw new HTTPException(401, { message: 'Unknown runner token' })
    c.set('runner', runner)
    await next()
  })

  .get('/', async (c) => c.json(await manifest(scoped(c.var.runner))))

  .get('/files/:id', async (c) => {
    const { runner } = c.var
    const row = await libraryFile(scoped(runner), c.req.param('id'))
    const bytes = await readLibraryFile(runner, row.id)
    return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
      'content-type': 'application/octet-stream',
      'x-sha256': row.sha256,
    })
  })
