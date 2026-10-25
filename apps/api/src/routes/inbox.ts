// The Inbox (src/inbox.ts): the list across sources, one item, done, handed to a teammate.
import { HandInboxItem, InboxQuery, SetInboxDone } from '@brigade/contracts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { handItem, listInbox, readItem, setDone, waitingCount } from '../inbox.js'
import { parseBody, requireUser, requireWorkspace, type AppEnv } from '../scope.js'

export const inbox = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)

  /** ?source=&teammate=&project=&status=waiting|handled|done|all&q=&before= */
  .get('/', async (c) => {
    const query = InboxQuery.safeParse(c.req.query())
    if (!query.success) throw new HTTPException(400, { message: 'Bad filters' })
    const q = query.data
    return c.json(
      await listInbox(c.var.db, c.var.scope, {
        ...(q.source ? { source: q.source } : {}),
        ...(q.teammate ? { teammateId: q.teammate } : {}),
        ...(q.project ? { projectId: q.project } : {}),
        status: q.status ?? 'waiting',
        ...(q.q ? { q: q.q } : {}),
        ...(q.before ? { before: new Date(q.before) } : {}),
      }),
    )
  })

  /** What waits on a person, counted beside Inbox in the sidebar. */
  .get('/count', async (c) => c.json({ waiting: await waitingCount(c.var.db) }))

  .get('/items/:id', async (c) => c.json(await readItem(c.var.db, c.var.scope, c.req.param('id'))))

  .post('/items/:id/done', async (c) => {
    const { done } = await parseBody(c.req.raw, SetInboxDone)
    await setDone(c.var.db, c.var.scope, c.req.param('id'), done)
    return c.json({ ok: true })
  })

  .post('/items/:id/hand', async (c) => {
    const input = await parseBody(c.req.raw, HandInboxItem)
    return c.json(
      await handItem(c.var.db, c.var.scope, c.req.param('id'), {
        teammateId: input.teammateId,
        ...(input.note ? { note: input.note } : {}),
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      }),
      201,
    )
  })
