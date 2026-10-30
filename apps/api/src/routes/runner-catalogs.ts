// An App's catalog for a computer (src/catalogs.ts): the operations a grant gives on one of its
// accounts, which a thread's spec names rather than carries. The runner fetches it once per
// version and keeps it. Authenticated by the runner's token; only its own workspace's
// connections. The front sends it to the API Worker's own isolates, never to an object.
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { catalogFor, unsharedCatalog } from '../catalogs.js'
import { CATALOG_INCOMPLETE_HEADER, CATALOG_SHARED_PARAM } from '@brigade/contracts'
import { scoped } from '../db.js'
import { authenticateRunner } from '../hub.js'

export const runnerCatalogs = new Hono().get('/:connectionId', async (c) => {
  const runner = await authenticateRunner(c.req.header('authorization'))
  if (!runner) throw new HTTPException(401, { message: 'Unknown runner token' })
  const grant = c.req.query('scope')
  if (grant !== 'read' && grant !== 'read_write')
    throw new HTTPException(400, { message: 'Expected scope=read or scope=read_write' })
  const scope = { organizationId: runner.organizationId, workspaceId: runner.workspaceId }
  const db = scoped(scope)
  const connection = await db.connection.findFirst({
    where: { id: c.req.param('connectionId'), status: { not: 'removed' } },
    include: { app: { select: { disabledTools: true, mcp: true, updatedAt: true } } },
  })
  if (!connection) throw new HTTPException(404, { message: 'Connection not found' })
  // As it is now, whatever version the spec named: an older one is not kept anywhere. One its
  // server could not list now is empty for this turn, and says so: the runner does not keep it.
  const { text, complete } = await catalogFor(db, scope, connection, grant)
  // Shared as kept (sharedSubschemas); whole, as before, for a runner that does not ask so.
  const shared = c.req.query(CATALOG_SHARED_PARAM) === 'shared'
  return c.body(shared ? text : unsharedCatalog(text), 200, {
    'content-type': 'application/json',
    ...(complete ? {} : { [CATALOG_INCOMPLETE_HEADER]: '1' }),
  })
})
