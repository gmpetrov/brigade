// An MCP connector's tools, as teammates get and call them: listed from the
// server with the account's token (kept a few minutes), named after the App, and
// run through the same grant, policy and log as every connector call.
import { z } from 'zod'
import { authorisedFetch } from './connector-calls.js'
import { connectors, mcpToolName } from './connectors/index.js'
import { callMcpTool, listMcpTools, mcpWrites, type McpTool } from './connectors/mcp.js'
import { op, type ConnectorKind, type Operation } from './connectors/types.js'
import type { Scope, ScopedDb } from './db.js'
import { catalogTools, serverOf } from './mcp-servers.js'

const LIST_MS = 5 * 60_000
const listed = new Map<string, { at: number; tools: McpTool[] }>()

type McpConnection = {
  id: string
  appId: string
  kind: ConnectorKind
  vaultSecretId: string | null
}

/** Whether a kind's tools come from an MCP server rather than from Brigade. */
export const isMcp = (kind: ConnectorKind) => kind === 'mcp' || Boolean(connectors[kind]?.mcp)

async function serverFor(db: ScopedDb, connection: McpConnection) {
  const found = await serverOf(db, connection)
  if (!found) throw new Error('This App no longer has its MCP server')
  return found
}

async function toolsOf(
  db: ScopedDb,
  scope: Scope,
  connection: McpConnection,
  found: Awaited<ReturnType<typeof serverFor>>,
) {
  const hit = listed.get(connection.id)
  if (hit && Date.now() - hit.at < LIST_MS) return hit.tools
  const tools = await listMcpTools(await authorisedFetch(db, scope, connection), found.server)
  listed.set(connection.id, { at: Date.now(), tools })
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
  return (await toolsOf(db, scope, connection, found))
    .map((tool) => ({ tool, name: mcpToolName(prefix, tool.name) }))
    .filter(
      ({ tool, name }) =>
        (grant === 'read_write' || !mcpWrites(server, tool)) && !disabled.includes(name),
    )
    .map(({ tool, name }) => ({
      name,
      description: tool.description ?? server.tools[tool.name]?.description ?? tool.name,
      write: mcpWrites(server, tool),
      inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
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
    (t) => mcpToolName(prefix, t.name) === name,
  )
  if (!tool) return undefined
  return op({
    description: tool.description ?? tool.name,
    write: mcpWrites(server, tool),
    input: Input,
    target: targetOf,
    run: (ctx, input) => callMcpTool(ctx.fetch, server, tool.name, input),
  })
}

/** Forget a connection's tools, e.g. once it is disconnected. */
export const forgetMcpTools = (connectionId: string) => listed.delete(connectionId)
