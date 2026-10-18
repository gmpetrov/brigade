// Home's loose ends and results, for the member asking (src/home.ts).
import { Hono } from 'hono'
import { z } from 'zod'
import { dismissLooseEnd, homeFor } from '../home.js'
import { parseBody, requireUser, requireWorkspace, type AppEnv } from '../scope.js'

const Dismiss = z.object({ key: z.string().regex(/^(proposal|stalled|routine):[\w:-]{1,200}$/) })

export const home = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)

  .get('/', async (c) => c.json(await homeFor(c.var.db, c.var.scope.memberId)))

  /** Set one aside: it comes back once what it names changes. */
  .post('/dismiss', async (c) => {
    const { key } = await parseBody(c.req.raw, Dismiss)
    await dismissLooseEnd(c.var.db, c.var.scope, key)
    return c.json({ ok: true })
  })
