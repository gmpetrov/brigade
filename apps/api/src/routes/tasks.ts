import { AssignTask, CompleteTask, CreateTask, UpdateTask } from '@brigade/contracts'
import { Hono } from 'hono'
import { parseBody, requireUser, requireWorkspace, type AppEnv } from '../scope.js'
import {
  archiveDoneTasks,
  archiveTask,
  assignTask,
  byMember,
  completeTask,
  createTask,
  deleteTask,
  getTask,
  listArchivedTasks,
  listTasks,
  listTrashedTasks,
  reopenTask,
  restoreTask,
  trashTask,
  unarchiveTask,
  updateTask,
} from '../tasks.js'

/** The Tasks board: work to see finished, each with at most one thread. */
export const tasks = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)

  /**
   * The board; ?archived=true for the done tasks put away instead, a page at
   * a time; ?trashed=true for the Trash.
   */
  .get('/', async (c) =>
    c.json(
      c.req.query('archived') === 'true'
        ? await listArchivedTasks(c.var.db, c.req.query('before'))
        : c.req.query('trashed') === 'true'
          ? await listTrashedTasks(c.var.db)
          : await listTasks(c.var.db, c.req.query('project')),
    ),
  )

  .get('/:id', async (c) => c.json(await getTask(c.var.db, c.req.param('id'))))

  /** Into Backlog, or started at once with a teammate; or from a thread ("Make this a task"). */
  .post('/', async (c) => {
    const input = await parseBody(c.req.raw, CreateTask)
    return c.json(await createTask(c.var.db, c.var.scope, input), 201)
  })

  .patch('/:id', async (c) => {
    const input = await parseBody(c.req.raw, UpdateTask)
    return c.json(await updateTask(c.var.db, byMember(c.var.scope), c.req.param('id'), input))
  })

  /** A teammate takes it: a backlog task's thread starts, a started one changes hands. */
  .post('/:id/assign', async (c) => {
    const input = await parseBody(c.req.raw, AssignTask)
    return c.json(await assignTask(c.var.db, byMember(c.var.scope), c.req.param('id'), input))
  })

  .post('/:id/complete', async (c) => {
    const input = await parseBody(c.req.raw, CompleteTask)
    return c.json(await completeTask(c.var.db, byMember(c.var.scope), c.req.param('id'), input))
  })

  .post('/:id/reopen', async (c) =>
    c.json(await reopenTask(c.var.db, byMember(c.var.scope), c.req.param('id'))),
  )

  /** Every done task off the board. */
  .post('/archive-done', async (c) => c.json(await archiveDoneTasks(c.var.db, c.var.scope)))

  .post('/:id/archive', async (c) =>
    c.json(await archiveTask(c.var.db, byMember(c.var.scope), c.req.param('id'))),
  )

  .post('/:id/unarchive', async (c) =>
    c.json(await unarchiveTask(c.var.db, byMember(c.var.scope), c.req.param('id'))),
  )

  .post('/:id/trash', async (c) =>
    c.json(await trashTask(c.var.db, byMember(c.var.scope), c.req.param('id'))),
  )

  .post('/:id/restore', async (c) =>
    c.json(await restoreTask(c.var.db, byMember(c.var.scope), c.req.param('id'))),
  )

  /** The task goes for good; its thread stays as a plain thread. */
  .delete('/:id', async (c) => {
    await deleteTask(c.var.db, c.var.scope, c.req.param('id'))
    return c.body(null, 204)
  })
