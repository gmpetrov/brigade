// Tools (docs/tools.md), from the dashboard: a tool's address on the sandbox origin, the accounts
// attached to it, and what its page asks the dashboard for (state, library files, App calls).
// Hidden, as if it did not exist, from people without the tools feature.
import {
  ApproveToolChange,
  AttachToolAccount,
  DetachToolAccount,
  OpenToolView,
  ToolCall,
  ToolFilesRequest,
  ToolOperationsRequest,
  ToolStateRequest,
} from '@brigade/contracts'
import { Hono, type MiddlewareHandler } from 'hono'
import { featuresOfUser, requireFeature } from '../features.js'
import { parseBody, requireUser, requireWorkspace, type AppEnv } from '../scope.js'
import {
  approveToolChange,
  attachToolAccount,
  callToolOperation,
  detachToolAccount,
  openToolView,
  toolFiles,
  toolOperations,
  toolState,
} from '../tools.js'

const requireTools: MiddlewareHandler<AppEnv> = async (c, next) => {
  requireFeature(await featuresOfUser(c.var.scope.userId, c.var.scope.workspaceId), 'tools')
  await next()
}

export const tools = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace, requireTools)

  /** A tool's page on the sandbox origin, good for a few hours, and its accounts. */
  .post('/view', async (c) => {
    const { path } = await parseBody(c.req.raw, OpenToolView)
    return c.json(await openToolView(c.var.db, c.var.scope, path))
  })

  .post('/accounts', async (c) => {
    const input = await parseBody(c.req.raw, AttachToolAccount)
    await attachToolAccount(c.var.db, c.var.scope, input)
    return c.body(null, 204)
  })

  .post('/accounts/detach', async (c) => {
    const input = await parseBody(c.req.raw, DetachToolAccount)
    await detachToolAccount(c.var.db, c.var.scope, input)
    return c.body(null, 204)
  })

  /** Allow the accounts again once the tool changed. */
  .post('/accounts/allow', async (c) => {
    const { path } = await parseBody(c.req.raw, ApproveToolChange)
    return c.json({ allowed: await approveToolChange(c.var.db, c.var.scope, path) })
  })

  .post('/state', async (c) => {
    const request = await parseBody(c.req.raw, ToolStateRequest)
    return c.json({ result: await toolState(c.var.db, c.var.scope, request) })
  })

  .post('/files', async (c) => {
    const input = await parseBody(c.req.raw, ToolFilesRequest)
    return c.json(await toolFiles(c.var.db, c.var.scope, input))
  })

  .post('/operations', async (c) => {
    const input = await parseBody(c.req.raw, ToolOperationsRequest)
    return c.json(await toolOperations(c.var.db, c.var.scope, input))
  })

  .post('/call', async (c) => {
    const input = await parseBody(c.req.raw, ToolCall)
    return c.json(await callToolOperation(c.var.db, c.var.scope, input))
  })
