import { randomBytes, randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { audit } from '../audit.js'
import { env } from '../config.js'
import { connectors } from '../connectors/index.js'
import { ConnectGoogle, ConnectStripe } from '@brigade/contracts'
import { stripeAccount } from '../connectors/stripe.js'
import type { ConnectorKind } from '../connectors/types.js'
import { deleteWebhooks } from './webhooks.js'
import {
  exchangeGoogleCode,
  googleAccount,
  googleAuthUrl,
  googleConfigured,
  revokeGoogle,
  type GoogleCredential,
} from '../connectors/google-oauth.js'
import { prisma, scoped } from '../db.js'
import { hashToken } from '../hub.js'
import {
  parseBody,
  requireRole,
  requireUser,
  requireWorkspace,
  resolveScope,
  type AppEnv,
  type WorkspaceScope,
} from '../scope.js'
import { deleteSecret, openSecret, sealSecret } from '../vault.js'

const stateIdentifier = (state: string) => `oauth-state:${hashToken(state)}`
type OAuthState = {
  organizationId: string
  workspaceId: string
  memberId: string
  userId: string
  kind: 'gmail' | 'google_calendar'
}

/** Seal the credential in the vault and record the connection. */
async function createConnection(
  scope: WorkspaceScope,
  connection: { kind: ConnectorKind; label: string; externalAccount: string | null },
  credential: object,
) {
  const db = scoped(scope)
  const vaultSecretId = await sealSecret(db, scope, credential)
  const row = await db.connection.create({
    data: { ...connection, vaultSecretId, createdByMemberId: scope.memberId } as never,
  })
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: 'connection.created',
    target: { type: 'connection', id: row.id },
    data: { kind: connection.kind, account: connection.externalAccount },
  })
  return row
}

export const connections = new Hono<AppEnv>()
  .use(requireUser)

  /**
   * Google's redirect back after consent. The state was issued to this same
   * signed-in member and workspace; tokens go straight into the vault.
   */
  .get('/oauth/google/callback', async (c) => {
    const back = (query: string) => c.redirect(`${env.WEB_URL[0]}/app/connections?${query}`)
    const state = c.req.query('state') ?? ''
    const row = await prisma.verification.findFirst({
      where: { identifier: stateIdentifier(state), expiresAt: { gt: new Date() } },
    })
    if (!row) return back('error=expired')
    await prisma.verification.deleteMany({ where: { id: row.id } })
    const grant = JSON.parse(row.value) as OAuthState
    const scope = await resolveScope({
      userId: c.var.userId,
      activeOrganizationId: grant.organizationId,
      activeWorkspaceId: grant.workspaceId,
    })
    if (
      !scope ||
      scope.userId !== grant.userId ||
      (scope.role !== 'owner' && scope.role !== 'admin')
    )
      return back('error=forbidden')
    if (c.req.query('error') || !c.req.query('code')) return back('error=declined')

    let credential: GoogleCredential
    let account: string | null
    try {
      credential = await exchangeGoogleCode(c.req.query('code')!)
      account = await googleAccount(grant.kind, credential.accessToken)
    } catch (error) {
      console.error('google connection failed:', error instanceof Error ? error.message : error)
      return back('error=google')
    }
    const connection = await createConnection(
      scope,
      { kind: grant.kind, label: connectors[grant.kind]!.label, externalAccount: account },
      credential,
    )
    return back(`connected=${connection.id}`)
  })

  .use(requireWorkspace)

  .get('/', async (c) => {
    const rows = await c.var.db.connection.findMany({
      where: { status: { not: 'removed' } },
      include: { grants: { select: { teammateId: true, scope: true } } },
      orderBy: { createdAt: 'asc' },
    })
    return c.json({
      available: {
        gmail: googleConfigured(),
        google_calendar: googleConfigured(),
        stripe: true,
      },
      connections: rows.map(({ vaultSecretId: _secret, ...row }) => row),
    })
  })

  /** Start Google's consent flow for a new connection. Admins only. */
  .post('/google', async (c) => {
    requireRole(c.var.scope, 'owner', 'admin')
    if (!googleConfigured())
      throw new HTTPException(409, { message: 'Google is not configured on this Brigade server' })
    const { kind } = await parseBody(c.req.raw, ConnectGoogle)
    const state = randomBytes(24).toString('base64url')
    const value: OAuthState = { ...c.var.scope, kind }
    await prisma.verification.create({
      data: {
        id: randomUUID(),
        identifier: stateIdentifier(state),
        value: JSON.stringify(value),
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    })
    return c.json({ url: googleAuthUrl(kind, state) })
  })

  /** Connect Stripe with a key entered once here. It goes straight into the vault. */
  .post('/stripe', async (c) => {
    const { scope } = c.var
    requireRole(scope, 'owner', 'admin')
    const input = await parseBody(c.req.raw, ConnectStripe)
    let account: string
    try {
      account = await stripeAccount(input.apiKey)
    } catch (error) {
      throw new HTTPException(400, {
        message: `Stripe did not accept that key (${error instanceof Error ? error.message : 'error'})`,
      })
    }
    const connection = await createConnection(
      scope,
      { kind: 'stripe', label: input.label ?? 'Stripe', externalAccount: account },
      { apiKey: input.apiKey },
    )
    return c.json({ id: connection.id }, 201)
  })

  /** Every call made through a connection: who, what, on which object, and the outcome. */
  .get('/:id/calls', async (c) => {
    const connection = await c.var.db.connection.findFirst({ where: { id: c.req.param('id') } })
    if (!connection) throw new HTTPException(404, { message: 'Connection not found' })
    const calls = await c.var.db.connectionCall.findMany({
      where: { connectionId: connection.id },
      include: { teammate: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    })
    return c.json(calls)
  })

  /** Disconnect: revoke at the provider, delete the credential, keep the call log. */
  .delete('/:id', async (c) => {
    const { scope, db } = c.var
    requireRole(scope, 'owner', 'admin')
    const connection = await db.connection.findFirst({
      where: { id: c.req.param('id'), status: { not: 'removed' } },
    })
    if (!connection) throw new HTTPException(404, { message: 'Connection not found' })
    if (connection.vaultSecretId) {
      // Google tokens are revoked at Google. A Stripe key is revoked in Stripe's dashboard.
      if (connectors[connection.kind]?.auth === 'google') {
        const credential = await openSecret<GoogleCredential>(
          db,
          scope,
          connection.vaultSecretId,
        ).catch(() => null)
        if (credential) await revokeGoogle(credential)
      }
      await db.connection.updateMany({
        where: { id: connection.id },
        data: { status: 'removed', vaultSecretId: null },
      })
      await deleteSecret(db, connection.vaultSecretId)
    } else {
      await db.connection.updateMany({ where: { id: connection.id }, data: { status: 'removed' } })
    }
    await db.grant.deleteMany({ where: { connectionId: connection.id } })
    await deleteWebhooks(db, { connectionId: connection.id })
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'connection.removed',
      target: { type: 'connection', id: connection.id },
    })
    return c.body(null, 204)
  })
