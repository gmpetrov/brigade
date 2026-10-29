// Lists (docs/lists.md), from the dashboard: every checklist of the library, one with the
// threads and pull requests on its lines, a thread's items; handing lines to a teammate,
// attaching them to a thread, ticking one.
import { HandOffItems, LinkItems, SetItemDone } from '@brigade/contracts'
import { Hono } from 'hono'
import { z } from 'zod'
import {
  handOff,
  linkToThread,
  listDetail,
  listSummaries,
  pinList,
  pinnedLists,
  setItemDone,
  threadItems,
} from '../lists.js'
import { parseBody, requireUser, requireWorkspace, type AppEnv } from '../scope.js'

const HandOff = HandOffItems.extend({ projectId: z.string().nullish() })

export const lists = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)

  .get('/', async (c) => c.json(await listSummaries(c.var.db, c.var.scope)))

  /** The items a thread works on, for the card at its top. */
  .get('/threads/:sessionId', async (c) =>
    c.json(await threadItems(c.var.db, c.var.scope, c.req.param('sessionId'))),
  )

  /** Tick or untick an item, as a person does in its file. */
  .put('/items/:id/done', async (c) => {
    const { scope, db } = c.var
    const { done } = await parseBody(c.req.raw, SetItemDone)
    return c.json(
      await setItemDone(db, scope, { type: 'member', id: scope.memberId }, c.req.param('id'), done),
    )
  })

  /** The lists this member pinned in their sidebar. */
  .get('/pins', async (c) => c.json(await pinnedLists(c.var.db, c.var.scope.memberId)))

  /** Pin it under Pinned in this member's sidebar; DELETE unpins it. Each member's own. */
  .post('/:documentId/pin', async (c) => {
    await pinList(c.var.db, c.var.scope, c.req.param('documentId'))
    return c.json({ ok: true })
  })
  .delete('/:documentId/pin', async (c) => {
    await c.var.db.listPin.deleteMany({
      where: { memberId: c.var.scope.memberId, documentId: c.req.param('documentId') },
    })
    return c.json({ ok: true })
  })

  .get('/:documentId', async (c) =>
    c.json(await listDetail(c.var.db, c.var.scope, c.req.param('documentId'))),
  )

  /** Lines to a teammate: in one thread together, or a thread each. */
  .post('/:documentId/hand-off', async (c) => {
    const { scope, db } = c.var
    const body = await parseBody(c.req.raw, HandOff)
    return c.json(await handOff(db, scope, scope.memberId, c.req.param('documentId'), body))
  })

  /** Lines to a thread that runs already. */
  .post('/:documentId/link', async (c) => {
    const { scope, db } = c.var
    const body = await parseBody(c.req.raw, LinkItems)
    return c.json(await linkToThread(db, scope, scope.memberId, c.req.param('documentId'), body))
  })
