// The Board (docs/board.md), from the dashboard: what moves across the workspace's lists,
// threads and routines, computed on each read.
import { Hono } from 'hono'
import { board } from '../board.js'
import { requireUser, requireWorkspace, type AppEnv } from '../scope.js'

export const boardRoutes = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)

  .get('/', async (c) => c.json(await board(c.var.db, c.var.scope)))
