// Triggers, as admins manage them: chosen from each connection's catalog, with
// the vendor subscribed to the events they need (see subscriptions/).
import { randomBytes } from 'node:crypto'
import { CreateTrigger } from '@brigade/contracts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { audit } from '../audit.js'
import { env } from '../config.js'
import { triggerCatalog, triggersOf } from '../connectors/index.js'
import type { ConnectorKind } from '../connectors/types.js'
import type { Scope, ScopedDb } from '../db.js'
import { parseBody, requireRole, requireUser, requireWorkspace, type AppEnv } from '../scope.js'
import { delivery, SubscribeError, syncConnection, unavailable } from '../subscriptions/index.js'
import { deleteSecret, sealSecret } from '../vault.js'

const KINDS: ConnectorKind[] = ['gmail', 'google_calendar', 'stripe', 'github', 'webhook']

const urlOf = (pathToken: string) => `${env.API_URL}/hooks/${pathToken}`

/** Delete triggers and their signing secrets. The caller syncs the subscriptions. */
export async function deleteTriggers(
  db: ScopedDb,
  where: { connectionId?: string; teammateId?: string; id?: string },
) {
  const rows = await db.trigger.findMany({ where })
  for (const row of rows) {
    await db.trigger.deleteMany({ where: { id: row.id } })
    if (row.verificationSecretId) await deleteSecret(db, row.verificationSecretId)
  }
  return rows
}

/** Re-sync after triggers went away; a vendor error here only leaves a stale subscription. */
export async function resync(scope: Scope, connectionIds: Iterable<string>) {
  for (const id of new Set(connectionIds))
    await syncConnection(scope, id).catch((error) =>
      console.error(`resync ${id}:`, error instanceof Error ? error.message : error),
    )
}

export const triggers = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)

  .get('/', async (c) => {
    const rows = await c.var.db.trigger.findMany({
      include: { teammate: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    })
    return c.json(
      rows.map(({ verificationSecretId, pathToken, ...row }) => ({
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
    const [connection, teammate] = await Promise.all([
      db.connection.findFirst({ where: { id: input.connectionId, status: { not: 'removed' } } }),
      db.teammate.findFirst({ where: { id: input.teammateId, archivedAt: null } }),
    ])
    if (!connection || !teammate)
      throw new HTTPException(404, { message: 'Connection or teammate not found' })
    const definition = triggersOf(connection.kind)[input.event]
    if (!definition)
      throw new HTTPException(400, {
        message: `${connection.label} has no trigger "${input.event}"`,
      })
    const reason = unavailable(connection.kind)
    if (reason) throw new HTTPException(409, { message: reason })

    // Only the catalog's options, without empty ones.
    const options: Record<string, string> = {}
    for (const option of definition.options ?? []) {
      const value = input.options[option.name]?.trim()
      if (value) options[option.name] = value
      else if (option.required)
        throw new HTTPException(400, { message: `${option.label} is required` })
    }

    const custom = connection.kind === 'webhook'
    if (custom && !input.verification)
      throw new HTTPException(400, { message: 'Choose how the sender is verified' })
    const secret =
      custom && input.verification === 'hmac'
        ? `bwh_${randomBytes(32).toString('base64url')}`
        : null
    const pathToken = custom ? randomBytes(24).toString('base64url') : null
    const row = await db.trigger.create({
      data: {
        connectionId: connection.id,
        teammateId: teammate.id,
        label: input.label,
        event: input.event,
        options,
        pathToken,
        verification: custom ? input.verification : null,
        verificationSecretId: secret ? await sealSecret(db, scope, { secret }) : null,
        createdByMemberId: scope.memberId,
      } as never,
    })

    // Subscribe the vendor now, so a refusal is the admin's to see and the trigger is not kept.
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
      actor: { type: 'member', id: scope.memberId },
      action: 'trigger.created',
      target: { type: 'trigger', id: row.id },
      data: { connectionId: connection.id, teammateId: teammate.id, event: input.event, options },
    })
    return c.json(
      {
        id: row.id,
        url: pathToken ? urlOf(pathToken) : null,
        ...(secret ? { signingSecret: secret } : {}),
      },
      201,
    )
  })

  .delete('/:id', async (c) => {
    const { scope, db } = c.var
    requireRole(scope, 'owner', 'admin')
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
