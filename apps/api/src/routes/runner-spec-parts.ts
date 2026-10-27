// A large part of a thread's spec for a computer (src/spec-parts.ts): the runner fetches it by
// its SHA-256, once, when a command names it. Authenticated by the runner's token; only its own
// workspace's.
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { authenticateRunner } from '../hub.js'
import { readSpecPart } from '../spec-parts.js'

export const runnerSpecParts = new Hono().get('/:sha256', async (c) => {
  const runner = await authenticateRunner(c.req.header('authorization'))
  if (!runner) throw new HTTPException(401, { message: 'Unknown runner token' })
  const hash = c.req.param('sha256')
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new HTTPException(400, { message: 'Not a SHA-256' })
  const content = await readSpecPart(runner.workspaceId, hash)
  if (content === null) throw new HTTPException(404, { message: 'Part not found' })
  // As hashed: the runner checks the bytes it gets.
  return c.body(content, 200, { 'content-type': 'application/json' })
})
