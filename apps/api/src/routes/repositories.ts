// Repositories: what the workspace's GitHub connections reach, for mentioning
// one in a message. Teammates check one out through their own GitHub grants.
import { Hono } from 'hono'
import { workspaceRepositories } from '../git.js'
import { requireUser, requireWorkspace, type AppEnv } from '../scope.js'

export const repositories = new Hono<AppEnv>()
  .use(requireUser)
  .use(requireWorkspace)

  .get('/', async (c) =>
    c.json(await workspaceRepositories(c.var.db, c.var.scope).catch(() => [])),
  )
