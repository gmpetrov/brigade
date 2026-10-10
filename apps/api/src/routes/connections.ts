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
  githubAccount,
  githubAuthorizeUrl,
  githubConfigured,
  githubInstallUrl,
  verifiedInstallation,
} from '../connectors/github-app.js'
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
/** A member's GitHub connect request, from "Connect GitHub" until GitHub sends them back. */
const githubPending = (userId: string) => `github-pending:${userId}`
const STATE_MS = 10 * 60_000
type OAuthState = {
  organizationId: string
  workspaceId: string
  memberId: string
  userId: string
  kind: 'gmail' | 'google_calendar' | 'github'
  /** github: the installation GitHub named, still to be checked against the person. */
  installationId?: number
}

/**
 * The connect request a state was issued for. It must be the same signed-in
 * member, still an admin of that workspace. Returns the reason otherwise.
 */
async function takeState(identifier: string, userId: string) {
  const row = await prisma.verification.findFirst({
    where: { identifier, expiresAt: { gt: new Date() } },
  })
  if (!row) return 'expired'
  await prisma.verification.deleteMany({ where: { id: row.id } })
  const grant = JSON.parse(row.value) as OAuthState
  const scope = await resolveScope({
    userId,
    activeOrganizationId: grant.organizationId,
    activeWorkspaceId: grant.workspaceId,
  })
  if (!scope || scope.userId !== grant.userId || (scope.role !== 'owner' && scope.role !== 'admin'))
    return 'forbidden'
  return { grant, scope }
}

const saveState = (identifier: string, value: OAuthState) =>
  prisma.verification.create({
    data: {
      id: randomUUID(),
      identifier,
      value: JSON.stringify(value),
      expiresAt: new Date(Date.now() + STATE_MS),
    },
  })

/** Seal the credential in the vault and record the connection. */
async function createConnection(
  scope: WorkspaceScope,
  connection: {
    kind: ConnectorKind
    label: string
    externalAccount: string | null
    externalUrl?: string
  },
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
    const taken = await takeState(stateIdentifier(c.req.query('state') ?? ''), c.var.userId)
    if (typeof taken === 'string') return back(`error=${taken}`)
    const { grant, scope } = taken
    if (grant.kind === 'github') return back('error=forbidden')
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

  /**
   * GitHub's setup URL, after the app is installed or its repositories change.
   * The installation id here is only a claim: the member signs in to GitHub
   * next, and the callback checks that they reach that installation.
   */
  .get('/oauth/github/setup', async (c) => {
    const back = (query: string) => c.redirect(`${env.WEB_URL[0]}/app/connections?${query}`)
    // A member of an organization asked its owners to install the app; nothing is installed yet.
    if (c.req.query('setup_action') === 'request') return back('error=github_requested')
    const installationId = Number(c.req.query('installation_id'))
    if (!Number.isSafeInteger(installationId) || installationId <= 0) return back('error=declined')
    const taken = await takeState(githubPending(c.var.userId), c.var.userId)
    if (typeof taken === 'string') return back(`error=${taken}`)
    const state = randomBytes(24).toString('base64url')
    await saveState(stateIdentifier(state), { ...taken.grant, installationId })
    return c.redirect(githubAuthorizeUrl(state))
  })

  /** GitHub's redirect back after the member signs in. The vault keeps only the installation id. */
  .get('/oauth/github/callback', async (c) => {
    const back = (query: string) => c.redirect(`${env.WEB_URL[0]}/app/connections?${query}`)
    const taken = await takeState(stateIdentifier(c.req.query('state') ?? ''), c.var.userId)
    if (typeof taken === 'string') return back(`error=${taken}`)
    const { grant, scope } = taken
    if (grant.kind !== 'github' || !grant.installationId) return back('error=forbidden')
    if (c.req.query('error') || !c.req.query('code')) return back('error=declined')

    let installation: Awaited<ReturnType<typeof verifiedInstallation>>
    try {
      installation = await verifiedInstallation(c.req.query('code')!, grant.installationId)
    } catch (error) {
      console.error('github connection failed:', error instanceof Error ? error.message : error)
      return back('error=github')
    }
    if (!installation) return back('error=github_not_yours')

    // Changing the repositories on GitHub comes back here too: refresh the connection, don't add one.
    const db = scoped(scope)
    const existing = await db.connection.findFirst({
      where: { kind: 'github', externalUrl: installation.html_url, status: { not: 'removed' } },
    })
    if (existing) {
      await db.connection.updateMany({
        where: { id: existing.id },
        data: { externalAccount: githubAccount(installation), status: 'active' },
      })
      return back(`connected=${existing.id}`)
    }
    const connection = await createConnection(
      scope,
      {
        kind: 'github',
        label: connectors.github!.label,
        externalAccount: githubAccount(installation),
        externalUrl: installation.html_url,
      },
      { installationId: installation.id },
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
        github: githubConfigured(),
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
    await saveState(stateIdentifier(state), { ...c.var.scope, kind })
    return c.json({ url: googleAuthUrl(kind, state) })
  })

  /**
   * Start a GitHub connection: install Brigade's GitHub App and pick the
   * repositories. Admins only. One request per member at a time.
   */
  .post('/github', async (c) => {
    requireRole(c.var.scope, 'owner', 'admin')
    if (!githubConfigured())
      throw new HTTPException(409, { message: 'GitHub is not configured on this Brigade server' })
    const identifier = githubPending(c.var.scope.userId)
    await prisma.verification.deleteMany({ where: { identifier } })
    await saveState(identifier, { ...c.var.scope, kind: 'github' })
    return c.json({ url: githubInstallUrl() })
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
      // A GitHub installation stays: other workspaces may use it; it is uninstalled on GitHub.
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
