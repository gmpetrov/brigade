// The repositories the workspace's GitHub connections reach: what a message
// can mention and a teammate can check out. Any member reads them.
import { Hono } from 'hono'
import { workspaceRepositories } from '../git.js'
import { requireUser, requireWorkspace, type AppEnv } from '../scope.js'

export const repositories = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)
  .get('/', async (c) => c.json(await workspaceRepositories(c.var.db, c.var.scope).catch(() => [])))
