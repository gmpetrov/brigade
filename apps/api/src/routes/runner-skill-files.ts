// A skill's files for a computer: the runner fetches them, by their SHA-256,
// to write the skills in a teammate's working folder. Authenticated by the
// runner's token; only its own workspace's.
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { authenticateRunner } from '../hub.js'
import { readSkillFile } from '../skills.js'

export const runnerSkillFiles = new Hono().get('/:sha256', async (c) => {
  const runner = await authenticateRunner(c.req.header('authorization'))
  if (!runner) throw new HTTPException(401, { message: 'Unknown runner token' })
  const hash = c.req.param('sha256')
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new HTTPException(400, { message: 'Not a SHA-256' })
  const bytes = await readSkillFile(runner, hash)
  if (!bytes) throw new HTTPException(404, { message: 'File not found' })
  return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
    'content-type': 'application/octet-stream',
  })
})
