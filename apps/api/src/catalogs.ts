// An App's catalog: the operations a grant gives on one of its accounts, with their input schemas
// (CATALOG_PROTOCOL). They weigh what the App's tools weigh (PostHog's 247 came to 2.7 MB), so a
// thread's spec names them by a version rather than carrying them: the runner fetches each App's
// once (GET /runner/catalogs/<connectionId>, served outside the API's objects: src/front.ts) and
// keeps it while its version holds. Building a spec then never lists an App's tools, nor
// serializes their schemas, wherever it runs: in a workspace's hub, a few megabytes of them
// at each message or reconnect took its object past its memory and dropped its sockets.
import { createHash } from 'node:crypto'
import { CATALOG_PROTOCOL, type ApiToRunner, type ThreadSpec } from '@brigade/contracts'
import { connectors, operationSpecs } from './connectors/index.js'
import type { ConnectorKind } from './connectors/types.js'
import { prisma, scoped, type Scope, type ScopedDb } from './db.js'
import { isMcp, mcpOperationSpecs } from './mcp-tools.js'
import { noteFailure } from './ops/failures.js'

/** What a catalog is made from: a connection, with its App's switches. */
export type CatalogConnection = {
  id: string
  appId: string
  kind: ConnectorKind
  vaultSecretId: string | null
  mcpUrl?: string | null
  externalAccount?: string | null
  updatedAt: Date
  app: { disabledTools: string[]; mcp?: unknown; updatedAt: Date }
}

type Grant = 'read' | 'read_write'
export type CatalogOperation = ThreadSpec['connectors'][number]['operations'][number]

/** An MCP server's tools can change unannounced: its catalogs' versions turn over this often. */
export const MCP_VERSION_MS = 60 * 60_000
/** An App's catalog this long (in characters of its JSON) is reported: catalog-size. */
export const CATALOG_WARN_CHARS = 2_000_000
/** No catalog is longer: an App's last tools past it are left out, and it is reported. */
export const CATALOG_MAX_CHARS = 8_000_000

/** Brigade's own connectors' operations change with its code: a deploy turns their versions over. */
const BUILD = process.env.BRIGADE_BUILD_ID || `dev-${Date.now()}`

/** Whether a runner of this protocol fetches catalogs. Unknown (offline): it will, by then. */
export const takesCatalogs = (protocol: number | undefined) =>
  (protocol ?? CATALOG_PROTOCOL) >= CATALOG_PROTOCOL

/**
 * A catalog's version, from what it is made of, without listing its tools: the connection and
 * its App as they are now (an account signed in again, tools switched off), and Brigade's build
 * for its own connectors or the hour for an MCP server's.
 */
export function catalogVersion(connection: CatalogConnection, now = Date.now()) {
  const made = [
    connection.updatedAt.getTime(),
    connection.app.updatedAt.getTime(),
    [...connection.app.disabledTools].sort().join(','),
    isMcp(connection.kind)
      ? `mcp:${connection.mcpUrl ?? ''}:${Math.floor(now / MCP_VERSION_MS)}`
      : `build:${BUILD}`,
  ]
  return createHash('sha256').update(JSON.stringify(made)).digest('hex').slice(0, 32)
}

/**
 * The operations a grant gives on a connection: reads always, writes with read_write, none
 * switched off. An MCP server that could not list them (signed out, down) throws.
 */
async function listOperations(
  db: ScopedDb,
  scope: Scope,
  connection: CatalogConnection,
  grant: Grant,
): Promise<CatalogOperation[]> {
  const disabled = connection.app.disabledTools
  if (!isMcp(connection.kind))
    return connectors[connection.kind]
      ? operationSpecs(connection.kind as Parameters<typeof operationSpecs>[0], grant, disabled)
      : []
  return mcpOperationSpecs(db, scope, connection, grant, disabled)
}

/** The operations a grant gives, or none when its MCP server could not list them: the thread runs without them. */
export async function grantOperations(
  db: ScopedDb,
  scope: Scope,
  connection: CatalogConnection,
  grant: Grant,
): Promise<CatalogOperation[]> {
  return listOperations(db, scope, connection, grant).catch((error: unknown) => {
    console.warn(`mcp tools of ${connection.id}: ${String(error)}`)
    return []
  })
}

/**
 * A catalog's JSON, as the runner gets it: past CATALOG_WARN_CHARS it is reported, and past
 * CATALOG_MAX_CHARS its last operations are left out, so that no App can grow a turn without
 * bound.
 */
export function catalogText(connectionId: string, kind: string, operations: CatalogOperation[]) {
  const text = JSON.stringify(operations)
  if (text.length <= CATALOG_WARN_CHARS) return text
  const size = `${(text.length / 1_000_000).toFixed(1)} M characters`
  if (text.length <= CATALOG_MAX_CHARS) {
    noteFailure('catalog-size', `${kind} (${connectionId}): ${size} of tools`)
    return text
  }
  const kept: CatalogOperation[] = []
  let length = 2
  for (const operation of operations) {
    const more = JSON.stringify(operation).length + 1
    if (length + more > CATALOG_MAX_CHARS) break
    kept.push(operation)
    length += more
  }
  noteFailure(
    'catalog-size',
    `${kind} (${connectionId}): ${size} of tools, ${operations.length - kept.length} of ${operations.length} left out`,
  )
  return JSON.stringify(kept)
}

/** Catalogs this isolate made lately, by connection, scope and version: each is made once. */
const made = new Map<string, string>()
/** How much of them is kept, in characters: the oldest go first past it. */
const KEPT_CHARS = 16_000_000
let keptChars = 0

/**
 * A connection's catalog for a grant, as JSON, made once per version in this isolate. One its
 * MCP server could not list now is empty and incomplete: never kept, here or by the runner, so the
 * next turn asks again rather than going without the App's tools until the version turns over.
 */
export async function catalogFor(
  db: ScopedDb,
  scope: Scope,
  connection: CatalogConnection,
  grant: Grant,
): Promise<{ text: string; complete: boolean }> {
  const key = `${connection.id}:${grant}:${catalogVersion(connection)}`
  const hit = made.get(key)
  if (hit !== undefined) return { text: hit, complete: true }
  let operations: CatalogOperation[]
  try {
    operations = await listOperations(db, scope, connection, grant)
  } catch (error) {
    console.warn(`mcp tools of ${connection.id}: ${String(error)}`)
    return { text: '[]', complete: false }
  }
  const text = catalogText(connection.id, connection.kind, operations)
  made.set(key, text)
  keptChars += text.length
  for (const [oldest, kept] of made) {
    if (keptChars <= KEPT_CHARS || oldest === key) break
    made.delete(oldest)
    keptChars -= kept.length
  }
  return { text, complete: true }
}

/**
 * A command with its catalogs' operations put back in its specs, whole, for a runner before
 * CATALOG_PROTOCOL. Such a runner updates itself once idle: until then its commands are as
 * large as they were.
 */
export async function inlineCatalogs<T extends ApiToRunner>(workspaceId: string, message: T) {
  if (!('thread' in message)) return message
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { organizationId: true },
  })
  if (!workspace) return message
  const scope = { organizationId: workspace.organizationId, workspaceId }
  const db = scoped(scope)
  const inline = async (spec: ThreadSpec): Promise<ThreadSpec> => {
    if (!spec.connectors.some((c) => c.catalog)) return spec
    const connections = await db.connection.findMany({
      where: { id: { in: spec.connectors.map((c) => c.connectionId) } },
      include: { app: { select: { disabledTools: true, mcp: true, updatedAt: true } } },
    })
    const byId = new Map(connections.map((c) => [c.id, c]))
    const filled = await Promise.all(
      spec.connectors.map(async ({ catalog, ...grant }) => {
        const connection = byId.get(grant.connectionId)
        if (!catalog || !connection) return grant
        const { text } = await catalogFor(db, scope, connection, grant.scope)
        return { ...grant, operations: JSON.parse(text) as CatalogOperation[] }
      }),
    )
    return { ...spec, connectors: filled }
  }
  const thread = await inline(message.thread)
  if (message.type !== 'thread.prompt') return { ...message, thread }
  return { ...message, thread, then: await Promise.all(message.then.map(inline)) }
}
