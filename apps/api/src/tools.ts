// Tools (docs/tools.md): small web apps saved in the library as `<name>.tool`
// folders. Their pages run the teammate's script, so like designs they are
// served only from DESIGN_URL, under a short-lived signed address, as sandboxed
// documents with no cookies. What a tool does beyond its page goes through the
// dashboard around it (src/tool-bridge.ts), which calls the routes here with the
// person's session: library folders the tool declares, state it keeps, and App
// accounts people attached to it. An account works for a viewer only as it would
// for a thread they started (a personal one for its owner alone), only while the
// tool's files are those it was attached to, and a write only once the person
// confirmed it in the dashboard's own dialog.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import {
  TOOL_ENTRY,
  TOOL_MANIFEST,
  TOOL_STATE_KEYS_MAX,
  TOOL_STATE_VALUE_MAX,
  TOOL_THUMBNAIL,
  ToolManifest,
  toolFolderOf,
  addToHead,
  LIBRARY_READ_MAX,
  type ToolAccount,
  type ToolCall,
  type ToolCallResult,
  type ToolFile,
  type ToolOperation,
  type ToolStateEntry,
  type ToolStateRequest,
  type ToolView,
} from '@brigade/contracts'
import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { mayWrite } from './account-sharing.js'
import { audit } from './audit.js'
import { directUploads, presignGet } from './bucket.js'
import { grantOperations } from './catalogs.js'
import { env } from './config.js'
import { authorisedFetch } from './connector-calls.js'
import { appCatalog, connectors } from './connectors/index.js'
import {
  redact,
  type ConnectorContext,
  type ConnectorKind,
  type Operation,
} from './connectors/types.js'
import { Prisma, scoped, type Scope, type ScopedDb } from './db.js'
import { askedFile, designHost, separateHost, STATIC_HOSTS } from './designs.js'
import { readLibraryFile } from './library.js'
import { fileKey } from './library-objects.js'
import { customMcp } from './mcp-servers.js'
import { isMcp, mcpOperation } from './mcp-tools.js'
import { rateLimit } from './routes/events.js'
import type { WorkspaceScope } from './scope.js'
import { serveObject } from './serve-object.js'
import { toolBridgeScript } from './tool-bridge.js'

// ---------------------------------------------------------------------------
// A tool's folder
// ---------------------------------------------------------------------------

const libraryRow = (db: ScopedDb, path: string) =>
  db.document.findFirst({ where: { kind: 'library', deletedAt: null, path } })

/** A tool's files: every library file in its folder. */
const toolRows = (db: ScopedDb, folder: string) =>
  db.document.findMany({
    where: { kind: 'library', deletedAt: null, path: { startsWith: `${folder}/` } },
    orderBy: { path: 'asc' },
  })

type Row = Awaited<ReturnType<typeof toolRows>>[number]

/** `tool.json`, parsed leniently; null when missing or unreadable. */
async function readManifest(scope: Scope, row: Row | null | undefined) {
  if (!row) return null
  try {
    const text = new TextDecoder().decode(await readLibraryFile(scope, row))
    return ToolManifest.safeParse(JSON.parse(text)).data ?? null
  } catch {
    return null
  }
}

/**
 * What a tool's files are now: each file's path and sha256, its picture aside. Attaching an
 * account keeps it; once it differs, the tool's code may do something else than the person
 * attaching it saw, and its calls wait until someone allows it again.
 */
export const codeHashOf = (folder: string, rows: { path: string; sha256: string }[]) =>
  createHash('sha256')
    .update(
      rows
        .filter((r) => r.path !== `${folder}/${TOOL_THUMBNAIL}`)
        .map((r) => `${r.path.slice(folder.length + 1)}\n${r.sha256}`)
        .sort()
        .join('\n'),
    )
    .digest('hex')

type Tool = {
  folder: string
  rows: Row[]
  entry: Row
  manifest: ToolManifest | null
  codeHash: string
}

/** The tool a library path is in, or is: its folder, files, page and manifest. */
async function toolAt(db: ScopedDb, scope: Scope, path: string): Promise<Tool> {
  const folder = toolFolderOf(path)
  if (!folder) throw new HTTPException(400, { message: 'That is not in a tool folder' })
  const rows = await toolRows(db, folder)
  const entry = rows.find((r) => r.path === `${folder}/${TOOL_ENTRY}`)
  if (!entry) throw new HTTPException(404, { message: `The tool has no ${TOOL_ENTRY} yet` })
  const manifest = await readManifest(
    scope,
    rows.find((r) => r.path === `${folder}/${TOOL_MANIFEST}`),
  )
  return { folder, rows, entry, manifest, codeHash: codeHashOf(folder, rows) }
}

/** Whether a library path is one of the folders a tool reads (or the tool's own). */
const readable = (tool: { folder: string; manifest: ToolManifest | null }, path: string) =>
  [tool.folder, ...(tool.manifest?.reads ?? [])].some(
    (folder) => path === folder || path.startsWith(`${folder}/`),
  )

// ---------------------------------------------------------------------------
// The tool's address on the sandbox origin
// ---------------------------------------------------------------------------

/** How long a tool's address works. Reopening the tool gets a new one. */
const VIEW_SECONDS = 4 * 60 * 60

type ViewClaim = { o: string; w: string; p: string; e: number }

const b64url = (data: Buffer | string) => Buffer.from(data).toString('base64url')
// Its own key: a design's address never opens a tool, nor a tool's a design.
const sign = (payload: string) =>
  b64url(createHmac('sha256', `tool-view:${env.BETTER_AUTH_SECRET}`).update(payload).digest())

export function toolToken(scope: Scope, folder: string, now = Date.now()) {
  const claim: ViewClaim = {
    o: scope.organizationId,
    w: scope.workspaceId,
    p: folder,
    e: Math.floor(now / 1000) + VIEW_SECONDS,
  }
  const payload = b64url(JSON.stringify(claim))
  return { token: `${payload}.${sign(payload)}`, expiresAt: new Date(claim.e * 1000) }
}

export function readToolToken(token: string): ViewClaim | null {
  const [payload, signature] = token.split('.')
  if (!payload || !signature) return null
  const expected = Buffer.from(sign(payload))
  const given = Buffer.from(signature)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  try {
    const claim = JSON.parse(Buffer.from(payload, 'base64url').toString()) as ViewClaim
    return claim.e * 1000 > Date.now() ? claim : null
  } catch {
    return null
  }
}

/** Library files a tool reads are under this, in its address: `/t/<token>/_library/<path>`. */
export const TOOL_LIBRARY_PREFIX = '_library'

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/')

// ---------------------------------------------------------------------------
// Opening a tool
// ---------------------------------------------------------------------------

const admin = (scope: WorkspaceScope) => scope.role === 'owner' || scope.role === 'admin'

type AccountRow = {
  id: string
  kind: ConnectorKind
  label: string
  externalAccount: string | null
  status: string
  reach: 'mine' | 'workspace'
  createdByMemberId: string
  app: { name: string | null; mcp: unknown }
}

/** The App's name for people: a custom one's, else the catalog's. */
const appName = (c: AccountRow) => c.app.name ?? appCatalog[c.kind]?.name ?? c.kind

/** Whether a viewer's calls may use an account: as in a thread they started (apps.ts usableIn). */
export const usableBy = (c: { reach: string; createdByMemberId: string }, memberId: string) =>
  c.reach === 'workspace' || c.createdByMemberId === memberId

/**
 * Whether a member may attach an account to a tool: what attaching does is let everyone who may
 * use the account call it through the tool, so as for giving it to a teammate, its owner or an
 * owner or admin (apps.ts requireAccountManager); a personal account its owner only.
 */
export const mayAttachAccount = (
  scope: WorkspaceScope,
  c: { reach: string; createdByMemberId: string },
) =>
  scope.role !== 'viewer' &&
  (c.createdByMemberId === scope.memberId || (c.reach === 'workspace' && admin(scope)))

/** Whether an account is of an App a tool asks for: by its kind, or a custom server's prefix. */
const askedFor = (manifest: ToolManifest | null, c: { kind: string; app: { mcp: unknown } }) =>
  (manifest?.apps ?? []).some(
    (need) => need.kind === c.kind || need.kind === customMcp(c.app)?.prefix,
  )

const ACCOUNT_SELECT = {
  id: true,
  kind: true,
  label: true,
  externalAccount: true,
  status: true,
  reach: true,
  createdByMemberId: true,
  app: { select: { name: true, mcp: true } },
} as const

/**
 * A tool's address on the sandbox origin, what it says about itself, the accounts attached to it
 * and those this member could attach, and where its messages go: the thread that saved it last,
 * when this member may see it.
 */
export async function openToolView(
  db: ScopedDb,
  scope: WorkspaceScope,
  path: string,
): Promise<ToolView> {
  const tool = await toolAt(db, scope, path)
  const latest = [...tool.rows].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
  const sessionId = latest.find((r) => r.updatedInSessionId)?.updatedInSessionId
  const teammateId = latest.find((r) => r.updatedByType === 'teammate')?.updatedById
  const [session, teammate, attached, accounts] = await Promise.all([
    sessionId
      ? db.session.findFirst({
          where: {
            id: sessionId,
            OR: [{ private: false }, { startedByMemberId: scope.memberId }],
          },
          include: { computer: { select: { kind: true } } },
        })
      : null,
    teammateId ? db.teammate.findFirst({ where: { id: teammateId, archivedAt: null } }) : null,
    db.toolAccount.findMany({
      where: { toolId: tool.entry.id, connection: { status: { not: 'removed' } } },
      include: { connection: { select: ACCOUNT_SELECT } },
      orderBy: { createdAt: 'asc' },
    }),
    tool.manifest?.apps?.length
      ? db.connection.findMany({
          where: { status: 'active' },
          select: ACCOUNT_SELECT,
          orderBy: { createdAt: 'asc' },
        })
      : [],
  ])
  const names = await memberNames(
    db,
    attached.flatMap((a) => (a.attachedByMemberId ? [a.attachedByMemberId] : [])),
  )
  const { token, expiresAt } = toolToken(scope, tool.folder)
  const taken = new Set(attached.map((a) => a.connectionId))
  return {
    url: `${env.DESIGN_URL}/t/${token}/${TOOL_ENTRY}`,
    folder: tool.folder,
    manifest: tool.manifest,
    toolId: tool.entry.id,
    thread: session
      ? { id: session.id, title: session.title, mayPrompt: mayWrite(session, scope) }
      : null,
    teammate: teammate ? { id: teammate.id, name: teammate.name } : null,
    accounts: attached.map((a): ToolAccount => ({
      connectionId: a.connectionId,
      kind: customMcp(a.connection.app)?.prefix ?? a.connection.kind,
      app: appName(a.connection),
      account: a.connection.externalAccount ?? a.connection.label,
      access: a.access,
      usable: a.connection.status === 'active' && usableBy(a.connection, scope.memberId),
      changed: a.codeHash !== tool.codeHash,
      attachedBy: a.attachedByMemberId ? (names.get(a.attachedByMemberId) ?? null) : null,
    })),
    attachable: accounts
      .filter((c) => !taken.has(c.id) && askedFor(tool.manifest, c) && mayAttachAccount(scope, c))
      .map((c) => ({
        connectionId: c.id,
        kind: customMcp(c.app)?.prefix ?? c.kind,
        app: appName(c),
        account: c.externalAccount ?? c.label,
      })),
    mayAttach: scope.role !== 'viewer',
    expiresAt: expiresAt.toISOString(),
  }
}

async function memberNames(db: ScopedDb, ids: string[]) {
  if (ids.length === 0) return new Map<string, string>()
  const members = await db.member.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: { id: true, user: { select: { name: true } } },
  })
  return new Map(members.map((m) => [m.id, m.user.name]))
}

// ---------------------------------------------------------------------------
// Attaching accounts
// ---------------------------------------------------------------------------

/** Attach an account to a tool, or change its access: its calls work with the tool as it is now. */
export async function attachToolAccount(
  db: ScopedDb,
  scope: WorkspaceScope,
  input: { path: string; connectionId: string; access: 'read' | 'read_write' },
) {
  const tool = await toolAt(db, scope, input.path)
  const connection = await db.connection.findFirst({
    where: { id: input.connectionId, status: 'active' },
    select: ACCOUNT_SELECT,
  })
  if (!connection) throw new HTTPException(404, { message: 'Account not found' })
  if (!askedFor(tool.manifest, connection))
    throw new HTTPException(400, {
      message: `The tool does not ask for ${appName(connection)} in its ${TOOL_MANIFEST}`,
    })
  if (!mayAttachAccount(scope, connection))
    throw new HTTPException(403, {
      message:
        connection.reach === 'mine'
          ? 'Only the member who connected this personal account can attach it'
          : 'Only the member who connected this account, or an owner or admin, can attach it',
    })
  const data = {
    access: input.access,
    codeHash: tool.codeHash,
    attachedByMemberId: scope.memberId,
  }
  await db.toolAccount.upsert({
    where: { toolId_connectionId: { toolId: tool.entry.id, connectionId: connection.id } },
    create: { toolId: tool.entry.id, connectionId: connection.id, ...data },
    update: data,
  })
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: 'tool.account_attached',
    target: { type: 'document', id: tool.entry.id },
    data: { folder: tool.folder, connectionId: connection.id, access: input.access },
  })
}

/** Take an account off a tool: the people allowed to attach it, and anyone who could not use it anyway. */
export async function detachToolAccount(
  db: ScopedDb,
  scope: WorkspaceScope,
  input: { path: string; connectionId: string },
) {
  const tool = await toolAt(db, scope, input.path)
  const attached = await db.toolAccount.findFirst({
    where: { toolId: tool.entry.id, connectionId: input.connectionId },
    include: { connection: { select: ACCOUNT_SELECT } },
  })
  if (!attached) return
  if (scope.role === 'viewer' || !mayAttachAccount(scope, attached.connection))
    throw new HTTPException(403, {
      message: 'Only the member who connected this account, or an owner or admin, can take it off',
    })
  await db.toolAccount.deleteMany({ where: { id: attached.id } })
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: 'tool.account_detached',
    target: { type: 'document', id: tool.entry.id },
    data: { folder: tool.folder, connectionId: input.connectionId },
  })
}

/**
 * Allow a tool's accounts again once its files changed: those this member may attach, as the
 * tool is now. Returns how many.
 */
export async function approveToolChange(db: ScopedDb, scope: WorkspaceScope, path: string) {
  const tool = await toolAt(db, scope, path)
  const attached = await db.toolAccount.findMany({
    where: { toolId: tool.entry.id, codeHash: { not: tool.codeHash } },
    include: { connection: { select: ACCOUNT_SELECT } },
  })
  const mine = attached.filter((a) => mayAttachAccount(scope, a.connection))
  if (attached.length > 0 && mine.length === 0)
    throw new HTTPException(403, {
      message: "Only the members who may attach this tool's accounts can allow it again",
    })
  if (mine.length === 0) return 0
  await db.toolAccount.updateMany({
    where: { id: { in: mine.map((a) => a.id) } },
    data: { codeHash: tool.codeHash, attachedByMemberId: scope.memberId },
  })
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: 'tool.change_allowed',
    target: { type: 'document', id: tool.entry.id },
    data: { folder: tool.folder, connectionIds: mine.map((a) => a.connectionId) },
  })
  return mine.length
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Whose keys: everyone's who opens the tool, or this member's own. */
const ownerOf = (shared: boolean, memberId: string) => (shared ? 'shared' : memberId)

const entryOf = (row: {
  key: string
  value: unknown
  version: number
  updatedAt: Date
}): ToolStateEntry => ({
  key: row.key,
  value: row.value,
  version: row.version,
  updatedAt: row.updatedAt.toISOString(),
})

const none = (key: string): ToolStateEntry => ({ key, value: null, version: 0, updatedAt: null })

/** A write over another version than the one the tool read: what is there now. */
const conflict = (current: ToolStateEntry) =>
  new HTTPException(409, {
    message: 'The key changed since it was read',
    res: Response.json(
      { error: 'The key changed since it was read', code: 'conflict', current },
      { status: 409 },
    ),
  })

const isUnique = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'

/** Read or write a tool's state. A viewer reads the shared keys and keeps their own, as people do. */
export async function toolState(
  db: ScopedDb,
  scope: WorkspaceScope,
  request: ToolStateRequest,
): Promise<ToolStateEntry | ToolStateEntry[] | null> {
  const tool = await toolAt(db, scope, request.path)
  const owner = ownerOf(request.shared, scope.memberId)
  const where = { toolId: tool.entry.id, owner }
  const current = async (key: string) => {
    const row = await db.toolState.findFirst({ where: { ...where, key } })
    return row ? entryOf(row) : none(key)
  }
  if (request.op === 'get') return current(request.key)
  if (request.op === 'list') {
    const rows = await db.toolState.findMany({
      where: { ...where, ...(request.prefix ? { key: { startsWith: request.prefix } } : {}) },
      orderBy: { key: 'asc' },
      take: TOOL_STATE_KEYS_MAX,
    })
    return rows.map(entryOf)
  }
  if (request.shared && scope.role === 'viewer')
    throw new HTTPException(403, { message: 'Viewers cannot change what everyone sees' })
  if (request.op === 'delete') {
    const gone = await db.toolState.deleteMany({
      where: {
        ...where,
        key: request.key,
        ...(request.version !== undefined ? { version: request.version } : {}),
      },
    })
    if (gone.count === 0 && request.version !== undefined)
      throw conflict(await current(request.key))
    return null
  }
  // set
  const value = (request.value ?? null) as Prisma.InputJsonValue
  if (JSON.stringify(value).length > TOOL_STATE_VALUE_MAX)
    throw new HTTPException(413, {
      message: `A value takes at most ${TOOL_STATE_VALUE_MAX} characters of JSON`,
    })
  const by = { updatedByMemberId: scope.memberId }
  const create = async () => {
    if ((await db.toolState.count({ where })) >= TOOL_STATE_KEYS_MAX)
      throw new HTTPException(413, {
        message: `A tool keeps at most ${TOOL_STATE_KEYS_MAX} keys for each person, and as many shared`,
      })
    return db.toolState.create({
      data: { toolId: tool.entry.id, owner, key: request.key, value, ...by },
    })
  }
  if (request.version === 0) {
    try {
      return entryOf(await create())
    } catch (error) {
      if (isUnique(error)) throw conflict(await current(request.key))
      throw error
    }
  }
  if (request.version !== undefined) {
    // Decided as it applies: only over the version the tool read.
    const updated = await db.toolState.updateMany({
      where: { ...where, key: request.key, version: request.version },
      data: { value, version: { increment: 1 }, ...by },
    })
    if (updated.count === 0) throw conflict(await current(request.key))
    return current(request.key)
  }
  // Whatever is there: over it, or new.
  const over = await db.toolState.updateMany({
    where: { ...where, key: request.key },
    data: { value, version: { increment: 1 }, ...by },
  })
  if (over.count > 0) return current(request.key)
  try {
    return entryOf(await create())
  } catch (error) {
    // Made meanwhile: write over it.
    if (!isUnique(error)) throw error
    await db.toolState.updateMany({
      where: { ...where, key: request.key },
      data: { value, version: { increment: 1 }, ...by },
    })
    return current(request.key)
  }
}

/** A tool's state as its thread's teammate reads it: the shared keys, and one member's own. */
export async function toolStateFor(
  db: ScopedDb,
  scope: Scope,
  path: string,
  memberId: string | null,
) {
  const tool = await toolAt(db, scope, path)
  const rows = await db.toolState.findMany({
    where: {
      toolId: tool.entry.id,
      owner: { in: ['shared', ...(memberId ? [memberId] : [])] },
    },
    orderBy: [{ owner: 'asc' }, { key: 'asc' }],
    take: TOOL_STATE_KEYS_MAX * 2,
  })
  const of = (owner: string) =>
    Object.fromEntries(rows.filter((r) => r.owner === owner).map((r) => [r.key, r.value]))
  return { folder: tool.folder, shared: of('shared'), ...(memberId ? { own: of(memberId) } : {}) }
}

// ---------------------------------------------------------------------------
// Library files a tool reads
// ---------------------------------------------------------------------------

/** Most files one listing returns. */
const FILES_MAX = 1000

/** The files of a folder the tool declares, with where its page loads each from. */
export async function toolFiles(
  db: ScopedDb,
  scope: WorkspaceScope,
  input: { path: string; folder: string },
): Promise<ToolFile[]> {
  const tool = await toolAt(db, scope, input.path)
  const folder = input.folder.replace(/\/+$/, '')
  if (!readable(tool, folder))
    throw new HTTPException(403, {
      message: `The tool reads ${folder} only once its ${TOOL_MANIFEST} lists it in "reads"`,
    })
  const rows = await db.document.findMany({
    where: { kind: 'library', deletedAt: null, path: { startsWith: `${folder}/` } },
    orderBy: { path: 'asc' },
    take: FILES_MAX,
    select: { path: true, contentType: true, size: true, updatedAt: true },
  })
  const { token } = toolToken(scope, tool.folder)
  return rows.map((r) => ({
    path: r.path,
    name: r.path.split('/').pop()!,
    contentType: r.contentType,
    size: r.size,
    updatedAt: r.updatedAt.toISOString(),
    url: `${env.DESIGN_URL}/t/${token}/${TOOL_LIBRARY_PREFIX}/${encodePath(r.path)}`,
  }))
}

// ---------------------------------------------------------------------------
// Calling an App
// ---------------------------------------------------------------------------

/** Calls one member makes through tools, a minute: enough for a dashboard, not for a loop. */
const calls = rateLimit(120, 60_000)

/** An attached account a viewer may call now, with its App's state; throws why not. */
async function callableAccount(
  db: ScopedDb,
  scope: WorkspaceScope,
  tool: Tool,
  connectionId: string,
) {
  const attached = await db.toolAccount.findFirst({
    where: { toolId: tool.entry.id, connectionId },
    include: {
      connection: {
        select: {
          ...ACCOUNT_SELECT,
          appId: true,
          vaultSecretId: true,
          mcpUrl: true,
          updatedAt: true,
          app: { select: { name: true, mcp: true, disabledTools: true, updatedAt: true } },
        },
      },
    },
  })
  if (!attached || attached.connection.status === 'removed')
    throw new HTTPException(404, { message: 'That account is not attached to this tool' })
  const connection = attached.connection
  if (!usableBy(connection, scope.memberId))
    throw new HTTPException(403, {
      message: `${connection.externalAccount ?? connection.label} is a personal account: only its owner's calls use it`,
    })
  if (attached.codeHash !== tool.codeHash)
    throw new HTTPException(409, {
      message: 'The tool changed since this account was attached: allow it again to use it',
      res: Response.json(
        {
          error: 'The tool changed since this account was attached: allow it again to use it',
          code: 'tool_changed',
        },
        { status: 409 },
      ),
    })
  if (connection.status !== 'active')
    throw new HTTPException(409, {
      message: `The sign-in of ${connection.externalAccount ?? connection.label} expired: its owner reconnects it in Apps`,
    })
  return { attached, connection }
}

/** The operations of an attached account the tool may call: reads, and writes when attached so. */
export async function toolOperations(
  db: ScopedDb,
  scope: WorkspaceScope,
  input: { path: string; connectionId: string },
): Promise<ToolOperation[]> {
  const tool = await toolAt(db, scope, input.path)
  const { attached, connection } = await callableAccount(db, scope, tool, input.connectionId)
  if (connectors[connection.kind]?.auth === 'brigade') return []
  const operations = await grantOperations(db, scope, connection, attached.access)
  return operations
    .filter((o) => !('filesField' in o && o.filesField))
    .map((o) => ({
      name: o.name,
      description: o.description,
      write: o.write,
      inputSchema: o.inputSchema,
    }))
}

/** An App's operation by name, as connector-calls finds it; undefined when it has none. */
async function operationOf(
  db: ScopedDb,
  scope: Scope,
  connection: Parameters<typeof mcpOperation>[2],
  name: string,
): Promise<Operation | undefined> {
  if (isMcp(connection.kind))
    return mcpOperation(db, scope, connection, name).catch(() => undefined)
  return connectors[connection.kind]?.operations[name] as Operation | undefined
}

/** Files go to an App only from a thread. */
const noFiles = () => Promise.reject(new Error('Files are not available to tools'))

/**
 * Call an attached account's operation for the member viewing a tool. A write needs the account
 * attached with read_write and the person's confirmation in the dashboard (`confirmed`).
 */
export async function callToolOperation(
  db: ScopedDb,
  scope: WorkspaceScope,
  input: ToolCall,
): Promise<ToolCallResult> {
  if (scope.role === 'viewer')
    throw new HTTPException(403, { message: 'Viewers cannot use the Apps of tools' })
  if (!calls.take(scope.memberId))
    throw new HTTPException(429, { message: 'Too many calls from tools: wait a minute' })
  const tool = await toolAt(db, scope, input.path)
  const { attached, connection } = await callableAccount(db, scope, tool, input.connectionId)
  if (connectors[connection.kind]?.auth === 'brigade')
    throw new HTTPException(400, { message: `${appName(connection)} is not available to tools` })
  if (connection.app.disabledTools.includes(input.operation))
    throw new HTTPException(403, { message: `${input.operation} is turned off for this App` })
  const operation = await operationOf(db, scope, connection, input.operation)
  if (!operation)
    throw new HTTPException(404, {
      message: `${appName(connection)} has no operation ${input.operation}`,
    })
  if (operation.files)
    throw new HTTPException(400, { message: `${input.operation} sends files: not from a tool` })
  if (operation.write && attached.access !== 'read_write')
    throw new HTTPException(403, {
      message: `${input.operation} changes things: the account is attached to read only`,
    })
  if (operation.write && !input.confirmed)
    throw new HTTPException(428, { message: 'A person confirms each write first' })
  const parsed = operation.input.safeParse(input.input ?? {})
  if (!parsed.success)
    throw new HTTPException(400, {
      message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    })
  const fetch = await authorisedFetch(db, scope, connection)
  const callId = `tool-${crypto.randomUUID()}`
  const ctx: ConnectorContext = {
    fetch,
    callId,
    keepFile: noFiles,
    openFile: noFiles,
    // Gmail reads what Brigade keeps of its mailbox: its workspace and account.
    ...(connection.kind === 'gmail' ? { scope, connectionId: connection.id } : {}),
  }
  if (operation.check) {
    const refused = await operation.check(ctx, parsed.data).catch((e: unknown) => String(e))
    if (refused) return { ok: false, error: refused }
  }
  let target = ''
  try {
    target = operation.target(parsed.data)
  } catch {
    // Only for the audit.
  }
  try {
    const output = await operation.run(ctx, parsed.data)
    if (operation.write)
      await audit({
        ...scope,
        actor: { type: 'member', id: scope.memberId },
        action: 'tool.app_write',
        target: { type: 'document', id: tool.entry.id },
        data: {
          folder: tool.folder,
          connectionId: connection.id,
          operation: input.operation,
          target,
        },
      })
    // What the App answered, as JSON: anything else is not the page's to see.
    return { ok: true, output: JSON.parse(JSON.stringify(output ?? null)) as unknown }
  } catch (error) {
    return { ok: false, error: redact(error instanceof Error ? error.message : String(error)) }
  }
}

// ---------------------------------------------------------------------------
// Serving a tool on the sandbox origin
// ---------------------------------------------------------------------------

/**
 * What a tool page may do: what a design's may (src/designs.ts), and call the public APIs its
 * manifest lists. Its calls to Apps go through the dashboard, never from here.
 */
export const toolCsp = (hosts: readonly string[] = []) =>
  [
    'sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads',
    "default-src 'self' https: data: blob: 'unsafe-inline' 'unsafe-eval'",
    `connect-src 'self' data: blob: ${[...STATIC_HOSTS, ...hosts].join(' ')}`,
    "form-action 'none'",
    `frame-ancestors ${env.WEB_URL.join(' ')}`,
  ].join('; ')

const MEDIA = /^(audio|video)\//

/** A library file a tool reads: as the library serves it, never as a page that runs script. */
async function serveLibraryFile(c: Context, scope: Scope, row: Row) {
  const key = fileKey(scope, row)
  const disposition = `inline; filename*=UTF-8''${encodeURIComponent(row.path.split('/').pop()!)}`
  // Video and large files from the bucket's own address, which answers a player's ranges.
  if (directUploads && (MEDIA.test(row.contentType) || row.size > LIBRARY_READ_MAX)) {
    const signed = await presignGet(key, { contentType: row.contentType, disposition })
    c.header('cache-control', `private, max-age=${Math.max(0, signed.seconds - 60)}`)
    return c.redirect(signed.url, 302)
  }
  return serveObject(c, key, {
    'content-type': row.contentType,
    'content-disposition': disposition,
    // An HTML or SVG file here is shown, never run.
    'content-security-policy': 'sandbox',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'access-control-allow-origin': '*',
    'cache-control': 'private, max-age=60',
  })
}

/** A tool's files under `/t/<token>/`, and the library files it reads under `_library/`. */
export const toolPages = new Hono().get('/:token/*', async (c) => {
  if (separateHost && c.req.header('host') !== designHost) return c.text('Not found', 404)
  const claim = readToolToken(c.req.param('token'))
  if (!claim) return c.text('This link has expired. Open the tool again.', 410)
  const rest = askedFile(c.req.path, `/t/${c.req.param('token')}/`)
  if (!rest) return c.text('Not found', 404)
  const scope = { organizationId: claim.o, workspaceId: claim.w }
  const db = scoped(scope)
  const folder = claim.p
  const manifest = await readManifest(scope, await libraryRow(db, `${folder}/${TOOL_MANIFEST}`))
  if (rest[0] === TOOL_LIBRARY_PREFIX && rest.length > 1) {
    const path = rest.slice(1).join('/')
    if (!readable({ folder, manifest }, path)) return c.text('Not found', 404)
    const row = await libraryRow(db, path)
    return row ? serveLibraryFile(c, scope, row) : c.text('Not found', 404)
  }
  const row = await libraryRow(db, [folder, ...rest].join('/'))
  if (!row) return c.text('Not found', 404)
  const html = row.contentType === 'text/html'
  const headers = {
    'content-type': row.contentType.startsWith('text/')
      ? `${row.contentType}; charset=utf-8`
      : row.contentType,
    'content-security-policy': toolCsp(manifest?.hosts),
    'x-content-type-options': 'nosniff',
    // The address carries the token: never sent on to the sites a tool loads from.
    'referrer-policy': 'no-referrer',
    // A sandboxed page's origin is opaque: its module scripts and fonts are cross-origin requests.
    'access-control-allow-origin': '*',
    'cache-control': html ? 'no-store' : 'private, max-age=60',
    'x-robots-tag': 'noindex, nofollow',
  }
  if (!html) return serveObject(c, fileKey(scope, row), headers)
  const page = addToHead(
    new TextDecoder().decode(await readLibraryFile(scope, row)),
    toolBridgeScript(),
    { first: true },
  )
  return c.body(new TextEncoder().encode(page), 200, headers)
})
