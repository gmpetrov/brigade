// MCP servers members add by their URL. Each is an App (key mcp:<hash of the URL>)
// that keeps the server in App.mcp: where it is, how its accounts sign in, the prefix
// of its tools' names, and the tools it last listed for the App's tool switches. The
// accounts are its connections, of kind mcp, as for every App.
import { createHash } from 'node:crypto'
import { connectors, mcpToolName } from './connectors/index.js'
import type { McpAuth, McpServer } from './connectors/types.js'
import type { ScopedDb } from './db.js'

export type McpTool = { name: string; description: string; write: boolean }

/** App.mcp. Never a secret: a client's secret is in the vault, by its id. */
export type CustomMcp = {
  url: string
  transport: 'streamable' | 'sse'
  auth: McpAuth
  /** api_key: the header the key goes in; default Authorization, as a Bearer token. */
  header?: string
  /** oauth: the client the member registered at the provider, when the server registers none. */
  client?: { id: string; secretId?: string }
  /** What its tools' names start with, e.g. nevo for nevo_search. Kept when the App is renamed. */
  prefix: string
  /** Images to show for it, best first. */
  icons: string[]
  description: string | null
  /** The tools its server last listed, by their names as teammates call them. */
  tools: McpTool[]
}

/** The same server however it was typed: no trailing slash, no fragment. */
export function normalUrl(raw: string) {
  const url = new URL(raw.trim())
  url.hash = ''
  return url.href.replace(/\/$/, '')
}

export const mcpAppKey = (url: string) =>
  `mcp:${createHash('sha256').update(normalUrl(url)).digest('hex').slice(0, 16)}`

export const customMcp = (app: { mcp?: unknown }) => (app.mcp ?? null) as CustomMcp | null

/** The server as the MCP client calls it. */
export const asServer = (mcp: CustomMcp): McpServer => ({
  url: mcp.url,
  tools: {},
  auth: mcp.auth,
  transport: mcp.transport,
  ...(mcp.client ? { client: mcp.client } : {}),
  ...(mcp.header ? { header: mcp.header } : {}),
})

/**
 * A prefix for an App's tools from its name, unlike any other App's: Nevo's Brain →
 * nevos_brain, then nevos_brain_2. Short, so the server's own tool names stay readable.
 */
export function toolPrefix(name: string, taken: readonly string[]) {
  const base =
    name
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 20)
      .replace(/_+$/, '') || 'mcp'
  // The built-in kinds are prefixes too.
  const used = new Set([...taken, ...Object.keys(connectors)])
  if (!used.has(base)) return base
  for (let n = 2; ; n++) if (!used.has(`${base}_${n}`)) return `${base}_${n}`
}

/** A connection's MCP server and the prefix of its tools, or null when it has none. */
export async function serverOf(
  db: ScopedDb,
  connection: { kind: string; appId: string },
): Promise<{ server: McpServer; prefix: string; app?: { id: string; mcp: CustomMcp } } | null> {
  const builtIn = connectors[connection.kind as keyof typeof connectors]?.mcp
  if (builtIn) return { server: builtIn, prefix: connection.kind }
  if (connection.kind !== 'mcp') return null
  const app = await db.app.findFirst({ where: { id: connection.appId } })
  const mcp = app && customMcp(app)
  if (!app || !mcp) return null
  return { server: asServer(mcp), prefix: mcp.prefix, app: { id: app.id, mcp } }
}

/** The tools as the App's switches show them: named as teammates call them. */
export const catalogTools = (
  prefix: string,
  tools: { name: string; description?: string; annotations?: { readOnlyHint?: boolean } }[],
): McpTool[] =>
  tools.map((t) => ({
    name: mcpToolName(prefix, t.name),
    description: t.description ?? t.name,
    write: t.annotations?.readOnlyHint !== true,
  }))
