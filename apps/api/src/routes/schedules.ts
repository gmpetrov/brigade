import { CreateSchedule, UpdateSchedule } from '@brigade/contracts'
import { Hono } from 'hono'
import {
  createSchedule,
  deleteSchedule,
  listSchedules,
  runNow,
  setPaused,
  updateSchedule,
} from '../schedules.js'
import { parseBody, requireUser, requireWorkspace, type AppEnv } from '../scope.js'

/** Schedules: a teammate prompted on a cron schedule, on its owner's accounts. */
export const schedules = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)

  .get('/', async (c) => c.json(await listSchedules(c.var.db)))

  /** The creator is the owner: runs use their accounts. */
  .post('/', async (c) => {
    const input = await parseBody(c.req.raw, CreateSchedule)
    return c.json(
      await createSchedule(c.var.db, c.var.scope, input, { memberId: c.var.scope.memberId }),
      201,
    )
  })

  .patch('/:id', async (c) => {
    const input = await parseBody(c.req.raw, UpdateSchedule)
    return c.json(await updateSchedule(c.var.db, c.var.scope, c.req.param('id'), input))
  })

  .post('/:id/pause', async (c) =>
    c.json(await setPaused(c.var.db, c.var.scope, c.req.param('id'), true)),
  )

  .post('/:id/resume', async (c) =>
    c.json(await setPaused(c.var.db, c.var.scope, c.req.param('id'), false)),
  )

  /** Run now; the next firing stays where it was. */
  .post('/:id/run', async (c) => c.json(await runNow(c.var.db, c.var.scope, c.req.param('id'))))

  /** Its threads stay as plain threads. */
  .delete('/:id', async (c) => {
    await deleteSchedule(c.var.db, c.var.scope, c.req.param('id'))
    return c.body(null, 204)
  })
