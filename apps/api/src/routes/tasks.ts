import { CompleteTask, CreateTask, ReassignTask, StartTask, UpdateTask } from '@brigade/contracts'
import { Hono } from 'hono'
import { parseBody, requireUser, requireWorkspace, type AppEnv } from '../scope.js'
import {
  archiveDoneTasks,
  archiveTask,
  completeTask,
  createTask,
  deleteTask,
  getTask,
  listTasks,
  reassignTask,
  reopenTask,
  startTask,
  unarchiveTask,
  updateTask,
} from '../tasks.js'

/** The Tasks board: work to see finished, each with at most one thread. */
export const tasks = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)

  /** The board; ?archived=true for the done tasks put away instead. */
  .get('/', async (c) =>
    c.json(await listTasks(c.var.db, { archived: c.req.query('archived') === 'true' })),
  )

  .get('/:id', async (c) => c.json(await getTask(c.var.db, c.req.param('id'))))

  /** By hand into Backlog, or from a thread ("Make this a task"). */
  .post('/', async (c) => {
    const input = await parseBody(c.req.raw, CreateTask)
    return c.json(await createTask(c.var.db, c.var.scope, input), 201)
  })

  .patch('/:id', async (c) => {
    const input = await parseBody(c.req.raw, UpdateTask)
    return c.json(await updateTask(c.var.db, c.var.scope, c.req.param('id'), input))
  })

  .post('/:id/start', async (c) => {
    const input = await parseBody(c.req.raw, StartTask)
    return c.json(await startTask(c.var.db, c.var.scope, c.req.param('id'), input))
  })

  .post('/:id/reassign', async (c) => {
    const input = await parseBody(c.req.raw, ReassignTask)
    return c.json(await reassignTask(c.var.db, c.var.scope, c.req.param('id'), input))
  })

  .post('/:id/complete', async (c) => {
    const input = await parseBody(c.req.raw, CompleteTask)
    return c.json(await completeTask(c.var.db, c.var.scope, c.req.param('id'), input))
  })

  .post('/:id/reopen', async (c) =>
    c.json(await reopenTask(c.var.db, c.var.scope, c.req.param('id'))),
  )

  /** Every done task off the board. */
  .post('/archive-done', async (c) => c.json(await archiveDoneTasks(c.var.db, c.var.scope)))

  .post('/:id/archive', async (c) =>
    c.json(await archiveTask(c.var.db, c.var.scope, c.req.param('id'))),
  )

  .post('/:id/unarchive', async (c) =>
    c.json(await unarchiveTask(c.var.db, c.var.scope, c.req.param('id'))),
  )

  /** The task goes; its thread stays as a plain thread. */
  .delete('/:id', async (c) => {
    await deleteTask(c.var.db, c.var.scope, c.req.param('id'))
    return c.body(null, 204)
  })
