// Triggers, as admins manage them: chosen from each connection's catalog, with
// the vendor subscribed to the events they need (see subscriptions/).
import { randomBytes } from 'node:crypto'
import { CreateTrigger, SetProject, UpdateTrigger } from '@brigade/contracts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { audit, type Actor } from '../audit.js'
import { env } from '../config.js'
import { triggerCatalog, triggersOf } from '../connectors/index.js'
import type { ConnectorKind } from '../connectors/types.js'
import type { Scope, ScopedDb } from '../db.js'
import { projectWhere, usableProject } from '../projects.js'
import { parseBody, requireRole, requireUser, requireWorkspace, type AppEnv } from '../scope.js'
import { delivery, SubscribeError, syncConnection, unavailable } from '../subscriptions/index.js'
import { deleteSecret, sealSecret } from '../vault.js'

const KINDS: ConnectorKind[] = [
  'gmail',
  'google_calendar',
  'google_drive',
  'google_docs',
  'google_sheets',
  'google_search_console',
  'google_analytics',
  'stripe',
  'github',
  'cloudflare',
  'google_cloud',
  'google_drive_mcp',
  'google_docs_mcp',
  'google_sheets_mcp',
  'neon',
  'supabase',
  'atlassian',
  'notion',
  'linear',
  'mixpanel',
  'resend',
  'replicate',
  'openrouter',
  'posthog',
  'dataforseo',
  'ahrefs',
  'revenuecat',
  'expo',
  'email',
  'mcp',
  'webhook',
]

export const urlOf = (pathToken: string) => `${env.API_URL}/hooks/${pathToken}`

/** Delete triggers and their signing secrets. The caller syncs the subscriptions. */
export async function deleteTriggers(
  db: ScopedDb,
  where: {
    connectionId?: string
    teammateId?: string
    id?: string
    playbookInstallationId?: string
  },
) {
  const rows = await db.trigger.findMany({ where })
  for (const row of rows) {
    await db.trigger.deleteMany({ where: { id: row.id } })
    if (row.verificationSecretId) await deleteSecret(db, row.verificationSecretId)
  }
  return rows
}

/** A playbook's triggers change only through it, so an update can replace them cleanly. */
async function notThePlaybooks(db: ScopedDb, id: string) {
  const row = await db.trigger.findFirst({
    where: { id },
    select: { playbookInstallationId: true },
  })
  if (row?.playbookInstallationId)
    throw new HTTPException(409, {
      message: 'This trigger belongs to a playbook: change it from the playbook, on Automations',
    })
}

type TriggerFields = {
  teammateId: string | null
  label: string
  options: unknown
  projectId: string | null
  instructions: string | null
}

const triggerFields = (row: TriggerFields) => ({
  teammateId: row.teammateId,
  label: row.label,
  options: row.options as never,
  projectId: row.projectId,
  instructions: row.instructions,
})

/** Re-sync after triggers went away; a vendor error here only leaves a stale subscription. */
export async function resync(scope: Scope, connectionIds: Iterable<string>) {
  for (const id of new Set(connectionIds))
    await syncConnection(scope, id).catch((error) =>
      console.error(`resync ${id}:`, error instanceof Error ? error.message : error),
    )
}

/**
 * What a trigger may be, checked against its account: its teammate, the catalog's options for its
 * event (without empty ones) and its project. Brigade's own addresses: an agent's rules are its
 * own, in the project of the variant they watch; an inbox's rules are its project's, and their
 * teammate gets the inbox to answer from. A mailbox's rule may have nobody (teammateId null): it
 * keeps its mail in the Inbox for a person, and starts no thread.
 */
async function checkedTrigger(
  db: ScopedDb,
  input: {
    connectionId: string
    teammateId: string | null
    event: string
    options: Record<string, string>
    projectId?: string | null
  },
) {
  const [connection, teammate] = await Promise.all([
    db.connection.findFirst({ where: { id: input.connectionId, status: { not: 'removed' } } }),
    input.teammateId
      ? db.teammate.findFirst({ where: { id: input.teammateId, archivedAt: null } })
      : null,
  ])
  if (!connection || (input.teammateId && !teammate))
    throw new HTTPException(404, { message: 'Connection or teammate not found' })
  const definition = triggersOf(connection.kind)[input.event]
  if (!definition)
    throw new HTTPException(400, {
      message: `${connection.label} has no trigger "${input.event}"`,
    })
  // Only a mailbox's rule keeps what it takes: any other event would go nowhere.
  if (!teammate && !definition.exclusive)
    throw new HTTPException(400, { message: 'Choose the teammate it starts threads with' })
  const reason = unavailable(connection.kind)
  if (reason) throw new HTTPException(409, { message: reason })

  const options: Record<string, string> = {}
  for (const option of definition.options ?? []) {
    const value = input.options[option.name]?.trim()
    if (value) options[option.name] = value
    else if (option.required)
      throw new HTTPException(400, { message: `${option.label} is required` })
  }

  let projectId = (await usableProject(db, input.projectId)) ?? null
  if (connection.kind === 'email') {
    const address = await db.mailAddress.findFirst({ where: { connectionId: connection.id } })
    if (!address || address.releasedAt)
      throw new HTTPException(404, { message: 'This address is turned off' })
    if (teammate && address.kind === 'agent' && address.teammateId !== teammate.id)
      throw new HTTPException(400, { message: `Only ${connection.label} answers its own address` })
    if (address.kind === 'inbox') {
      projectId = address.projectId
      if (
        teammate &&
        !(await db.grant.count({ where: { teammateId: teammate.id, connectionId: connection.id } }))
      )
        await db.grant.create({
          data: {
            teammateId: teammate.id,
            connectionId: connection.id,
            scope: 'read_write',
          } as never,
        })
    }
  }
  return { connection, teammate, options, projectId }
}

/**
 * Create a trigger and subscribe the vendor to its events now, so a refusal is seen by
 * whoever asked and the trigger is not kept. A custom app's hmac signing secret is only
 * ever returned here: the caller shows it once, or keeps it in the vault.
 */
export async function createTrigger(
  db: ScopedDb,
  scope: Scope,
  input: ReturnType<typeof CreateTrigger.parse>,
  by: {
    /** Its threads run on this member's accounts. */
    createdByMemberId: string
    actor: Actor
    /** Who approved it, when a teammate asked for it. */
    approvedByMemberId?: string
  },
) {
  const { connection, teammate, options, projectId } = await checkedTrigger(db, input)
  // Last among the account's rules: the first that matches a mail takes it.
  const last = await db.trigger.findFirst({
    where: { connectionId: connection.id },
    orderBy: { position: 'desc' },
    select: { position: true },
  })

  const custom = connection.kind === 'webhook'
  if (custom && !input.verification)
    throw new HTTPException(400, { message: 'Choose how the sender is verified' })
  const secret =
    custom && input.verification === 'hmac' ? `bwh_${randomBytes(32).toString('base64url')}` : null
  const pathToken = custom ? randomBytes(24).toString('base64url') : null
  const row = await db.trigger.create({
    data: {
      connectionId: connection.id,
      teammateId: teammate?.id ?? null,
      label: input.label,
      event: input.event,
      options,
      // Nobody reads a kept mail's instructions.
      instructions: (teammate && input.instructions) || null,
      pathToken,
      verification: custom ? input.verification : null,
      verificationSecretId: secret ? await sealSecret(db, scope, { secret }) : null,
      createdByMemberId: by.createdByMemberId,
      projectId,
      position: (last?.position ?? -1) + 1,
    } as never,
  })

  try {
    await syncConnection(scope, connection.id)
  } catch (error) {
    await deleteTriggers(db, { id: row.id })
    await resync(scope, [connection.id])
    if (error instanceof SubscribeError) throw new HTTPException(400, { message: error.message })
    throw new HTTPException(502, {
      message: `${connection.label} could not be subscribed to: ${error instanceof Error ? error.message : error}`,
    })
  }
  await audit({
    ...scope,
    actor: by.actor,
    action: 'trigger.created',
    target: { type: 'trigger', id: row.id },
    data: {
      connectionId: connection.id,
      teammateId: teammate?.id ?? null,
      event: input.event,
      options,
      ...(by.approvedByMemberId ? { approvedByMemberId: by.approvedByMemberId } : {}),
    },
  })
  return {
    id: row.id,
    connection,
    url: pathToken ? urlOf(pathToken) : null,
    signingSecret: secret,
  }
}

/**
 * How long a save holds its trigger, at most: far past any vendor's answer, so a refusal is undone
 * while held. The vendor's call is never cut short: one still running could subscribe after the
 * rollback's resync.
 */
export const SAVE_MS = 10 * 60_000

/**
 * What a trigger does (its teammate, label, options, project, instructions), changed in place,
 * keeping its place in its account's order; its vendor follows at once, and a refusal puts it
 * back as it was. Saves of one trigger run one at a time: each holds it (savingUntil) from its
 * read to its rollback, so one never undoes another's (a second save meanwhile gets a 409).
 * `sync` is the vendor's, given by tests.
 */
export async function updateTrigger(
  db: ScopedDb,
  scope: Scope,
  id: string,
  input: ReturnType<typeof UpdateTrigger.parse>,
  /** The member saving it, for the audit log. */
  memberId: string,
  /** Tests': the vendor, and shorter times. */
  test: {
    sync?: (scope: Scope, connectionId: string) => Promise<unknown>
    holdMs?: number
  } = {},
) {
  const { sync = syncConnection, holdMs = SAVE_MS } = test
  await notThePlaybooks(db, id)
  const now = new Date()
  const claim = new Date(now.getTime() + holdMs)
  const { count } = await db.trigger.updateMany({
    where: { id, OR: [{ savingUntil: null }, { savingUntil: { lt: now } }] },
    data: { savingUntil: claim },
  })
  if (!count) {
    if (!(await db.trigger.count({ where: { id } })))
      throw new HTTPException(404, { message: 'Trigger not found' })
    throw new HTTPException(409, { message: 'This rule is being saved. Try again in a moment.' })
  }
  // Every write is fenced by the hold, while it lasts: once it expired, another writer may have
  // taken the trigger (a save, a project change), and what it wrote stands.
  const held = () => ({ id, savingUntil: { equals: claim, gt: new Date() } })
  try {
    const before = await db.trigger.findFirst({ where: held() })
    if (!before) throw new HTTPException(404, { message: 'Trigger not found' })
    const { teammate, options, projectId } = await checkedTrigger(db, {
      ...input,
      connectionId: before.connectionId,
      event: before.event,
    })
    const wrote = await db.trigger.updateMany({
      where: held(),
      data: triggerFields({
        teammateId: teammate?.id ?? null,
        label: input.label,
        options,
        projectId,
        instructions: (teammate && input.instructions) || null,
      }),
    })
    if (!wrote.count)
      throw new HTTPException(409, { message: 'This rule was changed meanwhile. Try again.' })
    // The vendor follows the new options now, so a refusal is seen here and the old ones kept.
    try {
      await sync(scope, before.connectionId)
    } catch (error) {
      await db.trigger.updateMany({ where: held(), data: triggerFields(before) })
      await resync(scope, [before.connectionId])
      if (error instanceof SubscribeError) throw new HTTPException(400, { message: error.message })
      throw new HTTPException(502, {
        message: `It could not be subscribed to: ${error instanceof Error ? error.message : error}`,
      })
    }
    await audit({
      ...scope,
      actor: { type: 'member', id: memberId },
      action: 'trigger.updated',
      target: { type: 'trigger', id },
      data: { teammateId: teammate?.id ?? null, label: input.label, options, projectId },
    })
  } finally {
    await db.trigger.updateMany({ where: { id, savingUntil: claim }, data: { savingUntil: null } })
  }
}

/**
 * The project a trigger's threads start in. Not while a save holds it (409), as that save's
 * rollback would put the old one back; an expired hold is cleared, so a late rollback never does.
 */
export async function setTriggerProject(db: ScopedDb, id: string, projectId: string | null) {
  await notThePlaybooks(db, id)
  const { count } = await db.trigger.updateMany({
    where: { id, OR: [{ savingUntil: null }, { savingUntil: { lt: new Date() } }] },
    data: { projectId, savingUntil: null },
  })
  if (count) return
  if (await db.trigger.count({ where: { id } }))
    throw new HTTPException(409, { message: 'This rule is being saved. Try again in a moment.' })
  throw new HTTPException(404, { message: 'Trigger not found' })
}

export const triggers = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)

  /** ?project=<id|none>: a project's triggers, or those in none. */
  .get('/', async (c) => {
    const rows = await c.var.db.trigger.findMany({
      // A playbook's triggers show in the playbook.
      where: { ...projectWhere(c.req.query('project')), playbookInstallationId: null },
      include: {
        teammate: { select: { id: true, name: true } },
        project: { select: { id: true, name: true, icon: true, logo: true } },
      },
      orderBy: { createdAt: 'asc' },
    })
    return c.json(
      rows.map(({ verificationSecretId, pathToken, savingUntil: _saving, ...row }) => ({
        ...row,
        url: pathToken ? urlOf(pathToken) : null,
        hasSecret: Boolean(verificationSecretId),
      })),
    )
  })

  /** What each kind of connection can trigger on, and whether this server can set it up. */
  .get('/catalog', (c) =>
    c.json({
      catalog: triggerCatalog(),
      kinds: Object.fromEntries(
        KINDS.map((kind) => [kind, { delivery: delivery(kind), unavailable: unavailable(kind) }]),
      ),
    }),
  )

  /** Admins only. A custom app's hmac signing secret is shown once, in this response. */
  .post('/', async (c) => {
    const { scope, db } = c.var
    requireRole(scope, 'owner', 'admin')
    const input = await parseBody(c.req.raw, CreateTrigger)
    const created = await createTrigger(db, scope, input, {
      createdByMemberId: scope.memberId,
      actor: { type: 'member', id: scope.memberId },
    })
    return c.json(
      {
        id: created.id,
        url: created.url,
        ...(created.signingSecret ? { signingSecret: created.signingSecret } : {}),
      },
      201,
    )
  })

  /** The project its threads start in. Admins, like the rest of a trigger. */
  .put('/:id/project', async (c) => {
    const { scope, db } = c.var
    requireRole(scope, 'owner', 'admin')
    const { projectId } = await parseBody(c.req.raw, SetProject)
    const next = (await usableProject(db, projectId)) ?? null
    await setTriggerProject(db, c.req.param('id'), next)
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'trigger.updated',
      target: { type: 'trigger', id: c.req.param('id') },
      data: { projectId: next },
    })
    return c.json({ ok: true })
  })

  /**
   * Admins: what a trigger does (its teammate, label, options, project, instructions), changed in
   * place, keeping its place in its account's order. A playbook's changes in the playbook.
   */
  .put('/:id', async (c) => {
    const { scope, db } = c.var
    requireRole(scope, 'owner', 'admin')
    const input = await parseBody(c.req.raw, UpdateTrigger)
    await updateTrigger(db, scope, c.req.param('id'), input, scope.memberId)
    return c.json({ ok: true })
  })

  .delete('/:id', async (c) => {
    const { scope, db } = c.var
    requireRole(scope, 'owner', 'admin')
    await notThePlaybooks(db, c.req.param('id'))
    const [row] = await deleteTriggers(db, { id: c.req.param('id') })
    if (!row) throw new HTTPException(404, { message: 'Trigger not found' })
    await resync(scope, [row.connectionId])
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'trigger.deleted',
      target: { type: 'trigger', id: row.id },
    })
    return c.body(null, 204)
  })
