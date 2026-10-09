import { randomBytes, randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { audit } from '../audit.js'
import { env } from '../config.js'
import { connectors } from '../connectors/index.js'
import {
  exchangeGoogleCode,
  googleAuthUrl,
  googleConfigured,
  revokeGoogle,
  type GoogleCredential,
} from '../connectors/google-oauth.js'
import { prisma, scoped } from '../db.js'
import { hashToken } from '../hub.js'
import { requireRole, requireUser, requireWorkspace, resolveScope, type AppEnv } from '../scope.js'
import { deleteSecret, openSecret, sealSecret } from '../vault.js'

const stateIdentifier = (state: string) => `oauth-state:${hashToken(state)}`
type OAuthState = {
  organizationId: string
  workspaceId: string
  memberId: string
  userId: string
  kind: 'gmail' | 'google_calendar'
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

    const credential = await exchangeGoogleCode(c.req.query('code')!)
    // The mailbox address, to show which account this is. Never the credential.
    const profile = (await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers: { authorization: `Bearer ${credential.accessToken}` },
    }).then((r) => r.json())) as { emailAddress?: string }
    const db = scoped(scope)
    const vaultSecretId = await sealSecret(db, scope, credential)
    const connection = await db.connection.create({
      data: {
        kind: grant.kind,
        label: connectors[grant.kind]?.label ?? grant.kind,
        externalAccount: profile.emailAddress ?? null,
        vaultSecretId,
        createdByMemberId: scope.memberId,
      } as never,
    })
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'connection.created',
      target: { type: 'connection', id: connection.id },
      data: { kind: grant.kind, account: profile.emailAddress ?? null },
    })
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
      available: { gmail: googleConfigured() },
      connections: rows.map(({ vaultSecretId: _secret, ...row }) => row),
    })
  })

  /** Start Google's consent flow for a new connection. Admins only. */
  .post('/google', async (c) => {
    requireRole(c.var.scope, 'owner', 'admin')
    if (!googleConfigured())
      throw new HTTPException(409, { message: 'Google is not configured on this Brigade server' })
    const state = randomBytes(24).toString('base64url')
    const value: OAuthState = { ...c.var.scope, kind: 'gmail' }
    await prisma.verification.create({
      data: {
        id: randomUUID(),
        identifier: stateIdentifier(state),
        value: JSON.stringify(value),
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    })
    return c.json({ url: googleAuthUrl('gmail', state) })
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
      const credential = await openSecret<GoogleCredential>(
        db,
        scope,
        connection.vaultSecretId,
      ).catch(() => null)
      if (credential) await revokeGoogle(credential)
      await db.connection.updateMany({
        where: { id: connection.id },
        data: { status: 'removed', vaultSecretId: null },
      })
      await deleteSecret(db, connection.vaultSecretId)
    } else {
      await db.connection.updateMany({ where: { id: connection.id }, data: { status: 'removed' } })
    }
    await db.grant.deleteMany({ where: { connectionId: connection.id } })
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'connection.removed',
      target: { type: 'connection', id: connection.id },
    })
    return c.body(null, 204)
  })
