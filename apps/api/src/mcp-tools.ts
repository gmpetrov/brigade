// An MCP connector's tools, as teammates get and call them: listed from the
// server with the account's token (kept a few minutes), named after the App, and
// run through the same grant, policy and log as every connector call.
import { z } from 'zod'
import { authorisedFetch } from './connector-calls.js'
import { connectors, mcpToolName } from './connectors/index.js'
import { callMcpTool, listMcpTools, mcpWrites, type McpTool } from './connectors/mcp.js'
import {
  op,
  type ConnectorContext,
  type ConnectorKind,
  type McpServer,
  type Operation,
} from './connectors/types.js'
import type { Scope, ScopedDb } from './db.js'
import { fileFields, linkFiles, withFiles } from './file-links.js'
import { perHub } from './hub/context.js'
import { catalogTools, serverOf } from './mcp-servers.js'
import { ToolLists } from './tool-lists.js'

/** Each connection's tools lately listed, by connection: bounded, as they are the isolate's. */
const listed = new ToolLists<McpTool[]>()
/**
 * Lists under way, by connection: calls that need the same list at once wait on one listing
 * rather than each holding a copy. A hub's own, as a promise cannot cross objects.
 */
const listing = perHub('mcp-listing', () => new Map<string, Promise<McpTool[]>>())

type McpConnection = {
  id: string
  appId: string
  kind: ConnectorKind
  vaultSecretId: string | null
  /** The server it signed in to, for an App with one per data region. */
  mcpUrl?: string | null
  /** Which account it is, for an App whose calls all name it (Stripe's account and mode). */
  externalAccount?: string | null
}

/** Whether a kind's tools come from an MCP server rather than from Brigade. */
export const isMcp = (kind: ConnectorKind) => kind === 'mcp' || Boolean(connectors[kind]?.mcp)

async function serverFor(db: ScopedDb, connection: McpConnection) {
  const found = await serverOf(db, connection)
  if (!found) throw new Error('This App no longer has its MCP server')
  return found
}

/**
 * The arguments every call of this account carries (Stripe's account and mode), or {} for an
 * App with none. A row that does not say them signs in again first.
 */
async function fixedOf(db: ScopedDb, connection: McpConnection, server: McpServer) {
  if (!server.fixed) return {}
  const fixed = server.fixed({ externalAccount: connection.externalAccount ?? null })
  if (fixed) return fixed
  await db.connection.updateMany({ where: { id: connection.id }, data: { status: 'needs_reauth' } })
  throw new Error('This account must sign in again, choosing one account on the provider’s page')
}

/** A tool's input schema without the arguments Brigade adds itself. */
function withoutFixed(schema: Record<string, unknown>, fixed: Record<string, unknown>) {
  const keys = Object.keys(fixed)
  if (!keys.length) return schema
  const properties = { ...((schema.properties as Record<string, unknown> | undefined) ?? {}) }
  for (const key of keys) delete properties[key]
  const required = Array.isArray(schema.required)
    ? (schema.required as unknown[]).filter((k) => !keys.includes(k as string))
    : undefined
  return { ...schema, properties, ...(required ? { required } : {}) }
}

async function toolsOf(
  db: ScopedDb,
  scope: Scope,
  connection: McpConnection,
  found: Awaited<ReturnType<typeof serverFor>>,
) {
  const hit = listed.get(connection.id)
  if (hit) return hit
  const under = listing()
  const pending = under.get(connection.id)
  if (pending) return pending
  const list = listTools(db, scope, connection, found).finally(() => under.delete(connection.id))
  under.set(connection.id, list)
  return list
}

async function listTools(
  db: ScopedDb,
  scope: Scope,
  connection: McpConnection,
  found: Awaited<ReturnType<typeof serverFor>>,
) {
  const tools = await listMcpTools(await authorisedFetch(db, scope, connection), found.server)
  listed.set(connection.id, tools, JSON.stringify(tools).length)
  // A server added by its URL: its App's tool switches follow what it lists.
  if (found.app) {
    const now = catalogTools(found.prefix, tools)
    if (JSON.stringify(now) !== JSON.stringify(found.app.mcp.tools))
      await db.app.updateMany({
        where: { id: found.app.id },
        data: { mcp: { ...found.app.mcp, tools: now } },
      })
  }
  return tools
}

/** The tools a teammate gets on an MCP account: reads always, writes with read_write, none turned off. */
export async function mcpOperationSpecs(
  db: ScopedDb,
  scope: Scope,
  connection: McpConnection,
  grant: 'read' | 'read_write',
  disabled: readonly string[],
) {
  const found = await serverFor(db, connection)
  const { server, prefix } = found
  const fixed = await fixedOf(db, connection, server)
  return (await toolsOf(db, scope, connection, found))
    .filter((tool) => !server.hidden?.includes(tool.name))
    .map((tool) => ({ tool, name: mcpToolName(prefix, tool.name) }))
    .filter(
      ({ tool, name }) =>
        (grant === 'read_write' || !mcpWrites(server, tool)) && !disabled.includes(name),
    )
    .map(({ tool, name }) => ({
      name,
      description: tool.description ?? server.tools[tool.name]?.description ?? tool.name,
      write: mcpWrites(server, tool),
      // A file the tool takes by its address goes as a path the runner uploads (file-links.ts).
      ...withFiles(withoutFixed(tool.inputSchema ?? { type: 'object', properties: {} }, fixed)),
    }))
}

const Input = z.record(z.string(), z.unknown())

/** A call's object for approvals and the log: its inputs, short. */
const targetOf = (input: Record<string, unknown>) => {
  const text = Object.entries(input)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(', ')
  return text.length > 300 ? `${text.slice(0, 300)}…` : text || '(no input)'
}

/** One MCP tool by the name teammates call it, as an operation, or undefined. */
export async function mcpOperation(
  db: ScopedDb,
  scope: Scope,
  connection: McpConnection,
  name: string,
): Promise<Operation | undefined> {
  const found = await serverFor(db, connection)
  const { server, prefix } = found
  const tool = (await toolsOf(db, scope, connection, found)).find(
    (t) => mcpToolName(prefix, t.name) === name && !server.hidden?.includes(t.name),
  )
  if (!tool) return undefined
  const fixed = await fixedOf(db, connection, server)
  // Only the tools that take them get them (Stripe's documentation search takes no account).
  const properties = (tool.inputSchema?.properties ?? {}) as Record<string, unknown>
  const takes = Object.keys(fixed).filter((key) => key in properties)
  const complete = (input: Record<string, unknown>) => ({
    ...input,
    ...Object.fromEntries(takes.map((key) => [key, fixed[key]])),
  })
  // The files it takes by their address, given as uploads' ids: links to them, in their place.
  const files = fileFields(withoutFixed(tool.inputSchema ?? {}, fixed))
  const linked = (ctx: ConnectorContext, input: Record<string, unknown>) =>
    linkFiles(input, files, (id) => {
      if (!ctx.fileLink) throw new Error('Files can be sent to an App only from a thread')
      return ctx.fileLink(id)
    })
  return op({
    description: tool.description ?? tool.name,
    write: mcpWrites(server, tool),
    input: Input.refine(
      (input) => takes.every((key) => !(key in input) || input[key] === fixed[key]),
      {
        message: `This account is ${takes.map((key) => `${key} ${JSON.stringify(fixed[key])}`).join(', ')} only`,
      },
    ),
    target: (input) => server.target?.(tool.name, complete(input)) ?? targetOf(input),
    run: async (ctx, input) =>
      callMcpTool(ctx.fetch, server, tool.name, complete(await linked(ctx, input))),
  })
}

/**
 * Ask an MCP account's server for its tools, as a turn would (kept a few minutes, like them): a
 * server that refuses the account (an expired key: OpenRouter's lasts 7 days, with nothing to
 * renew it) marks it needs_reauth on the way (authorisedFetch), which is what this is for.
 * Throws when it could not list them, whatever the reason.
 */
export async function checkMcpSignIn(db: ScopedDb, scope: Scope, connection: McpConnection) {
  const found = await serverFor(db, connection)
  await fixedOf(db, connection, found.server)
  await toolsOf(db, scope, connection, found)
}

/** Forget a connection's tools, e.g. once it is disconnected. */
export const forgetMcpTools = (connectionId: string) => listed.delete(connectionId)
