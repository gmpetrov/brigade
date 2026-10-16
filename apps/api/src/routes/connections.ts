import { randomBytes, randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { audit } from '../audit.js'
import { env } from '../config.js'
import { appCatalog, connectors, toolCatalog } from '../connectors/index.js'
import {
  ConnectGitHub,
  ConnectGoogle,
  ConnectMcp,
  ConnectStripe,
  ConnectWebhookApp,
  UpdateApp,
  UpdateConnection,
} from '@brigade/contracts'
import { installAppSkills } from '../app-skills.js'
import { appFor, appKey, requireAccountManager, requireAppManager } from '../apps.js'
import { stripeAccount } from '../connectors/stripe.js'
import type { ConnectorKind } from '../connectors/types.js'
import { syncConnection } from '../subscriptions/index.js'
import { deleteTriggers } from './triggers.js'
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
import {
  callMcpTool,
  exchangeMcpCode,
  mcpAuthUrl,
  pkceVerifier,
  revokeMcp,
  type McpCredential,
} from '../connectors/mcp.js'
import { forgetMcpTools } from '../mcp-tools.js'
import { prisma, scoped, type ScopedDb } from '../db.js'
import { hashToken } from '../hub.js'
import {
  parseBody,
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
  kind: 'gmail' | 'google_calendar' | 'github' | 'cloudflare'
  /** github: the installation GitHub named, still to be checked against the person. */
  installationId?: number
  /** An MCP server's sign-in: the PKCE verifier for its code. */
  verifier?: string
  /** The dashboard page to send the person back to; default the Connections page. */
  returnTo?: string
}

/** Back to the dashboard after a connect attempt, with its result in the query. */
const backTo = (returnTo: string | undefined, query: string) => {
  const path = returnTo ?? '/app/connections'
  return `${env.WEB_URL[0]}${path}${path.includes('?') ? '&' : '?'}${query}`
}

/**
 * The connect request a state was issued for. It must be the same signed-in
 * member, still in that workspace. Returns the reason otherwise.
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
  if (!scope || scope.userId !== grant.userId) return 'forbidden'
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

/**
 * Seal the credential, if any, in the vault and record the connection as an
 * account of its App, adding the App the first time. A personal account (a
 * mailbox, a calendar) starts as the member's own: used only in their threads.
 */
async function createConnection(
  scope: WorkspaceScope,
  connection: {
    kind: ConnectorKind
    label: string
    externalAccount: string | null
    externalUrl?: string
  },
  credential: object | null,
) {
  const db = scoped(scope)
  const vaultSecretId = credential ? await sealSecret(db, scope, credential) : null
  const id = randomUUID()
  const custom = connection.kind === 'webhook'
  const app = await appFor(db, scope, appKey(connection.kind, id), custom ? connection.label : null)
  const row = await db.connection.create({
    data: {
      ...connection,
      id,
      appId: app.id,
      reach: appCatalog[connection.kind].personal ? 'mine' : 'workspace',
      vaultSecretId,
      createdByMemberId: scope.memberId,
    } as never,
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
    let back = (query: string) => c.redirect(backTo(undefined, query))
    const taken = await takeState(stateIdentifier(c.req.query('state') ?? ''), c.var.userId)
    if (typeof taken === 'string') return back(`error=${taken}`)
    const { grant, scope } = taken
    back = (query: string) => c.redirect(backTo(grant.returnTo, query))
    if (grant.kind !== 'gmail' && grant.kind !== 'google_calendar') return back('error=forbidden')
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
   * An MCP server's redirect back after its sign-in: the code and the PKCE
   * verifier for tokens, straight into the vault. The App's skills come with
   * its first account.
   */
  .get('/oauth/mcp/callback', async (c) => {
    let back = (query: string) => c.redirect(backTo(undefined, query))
    const taken = await takeState(stateIdentifier(c.req.query('state') ?? ''), c.var.userId)
    if (typeof taken === 'string') return back(`error=${taken}`)
    const { grant, scope } = taken
    back = (query: string) => c.redirect(backTo(grant.returnTo, query))
    const server = connectors[grant.kind]?.mcp
    if (!server || !grant.verifier) return back('error=forbidden')
    if (c.req.query('error') || !c.req.query('code')) return back('error=declined')

    let credential: McpCredential
    try {
      credential = await exchangeMcpCode(server, c.req.query('code')!, grant.verifier)
    } catch (error) {
      console.error('mcp connection failed:', error instanceof Error ? error.message : error)
      return back('error=mcp')
    }
    const account = await mcpAccount(server.url, credential)
    const kind = grant.kind as ConnectorKind
    const connection = await createConnection(
      scope,
      { kind, label: appCatalog[kind].name, externalAccount: account },
      credential,
    )
    const repository = appCatalog[kind].skills
    if (repository) {
      const db = scoped(scope)
      const has = await db.skillPack.count({ where: { appId: connection.appId } })
      if (!has)
        await installAppSkills(
          db,
          scope,
          { type: 'member', id: scope.memberId },
          { id: connection.appId, name: appCatalog[kind].name },
          repository,
        ).catch((error) =>
          console.error('app skills failed:', error instanceof Error ? error.message : error),
        )
    }
    return back(`connected=${connection.id}`)
  })

  /**
   * GitHub's setup URL, after the app is installed or its repositories change.
   * The installation id here is only a claim: the member signs in to GitHub
   * next, and the callback checks that they reach that installation.
   */
  .get('/oauth/github/setup', async (c) => {
    const back = (query: string) => c.redirect(backTo(undefined, query))
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
    let back = (query: string) => c.redirect(backTo(undefined, query))
    const taken = await takeState(stateIdentifier(c.req.query('state') ?? ''), c.var.userId)
    if (typeof taken === 'string') return back(`error=${taken}`)
    const { grant, scope } = taken
    back = (query: string) => c.redirect(backTo(grant.returnTo, query))
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
      include: {
        grants: { select: { teammateId: true, scope: true } },
        // How its triggers' events reach Brigade, and the last failure, if any.
        subscriptions: { select: { resource: true, mode: true, error: true, expiresAt: true } },
      },
      orderBy: { createdAt: 'asc' },
    })
    const [apps, members, packs] = await Promise.all([
      c.var.db.app.findMany({ orderBy: { createdAt: 'asc' } }),
      // Who connected each account.
      c.var.db.member.findMany({ select: { id: true, user: { select: { name: true } } } }),
      // The skills that came with each App.
      c.var.db.skillPack.findMany({
        where: { appId: { not: null } },
        select: {
          appId: true,
          skills: { select: { name: true, description: true }, orderBy: { name: 'asc' } },
        },
      }),
    ])
    return c.json({
      members: Object.fromEntries(members.map((m) => [m.id, m.user.name])),
      apps: apps.map((a) => ({
        id: a.id,
        key: a.key,
        name: a.name,
        disabledTools: a.disabledTools,
        createdByMemberId: a.createdByMemberId,
        skills: packs.filter((p) => p.appId === a.id).flatMap((p) => p.skills),
      })),
      catalog: Object.fromEntries(
        (Object.keys(appCatalog) as ConnectorKind[]).map((kind) => {
          const { personal: _personal, skills: source, ...app } = appCatalog[kind]
          return [kind, { ...app, tools: toolCatalog(kind), source: source ?? null }]
        }),
      ),
      available: {
        gmail: googleConfigured(),
        google_calendar: googleConfigured(),
        stripe: true,
        github: githubConfigured(),
        cloudflare: true,
        webhook: true,
      },
      connections: rows.map(({ vaultSecretId: _secret, ...row }) => row),
    })
  })

  /** Start Google's consent flow for a new connection. */
  .post('/google', async (c) => {
    if (!googleConfigured())
      throw new HTTPException(409, { message: 'Google is not configured on this Brigade server' })
    const { kind, returnTo } = await parseBody(c.req.raw, ConnectGoogle)
    const state = randomBytes(24).toString('base64url')
    await saveState(stateIdentifier(state), { ...c.var.scope, kind, returnTo })
    return c.json({ url: googleAuthUrl(kind, state) })
  })

  /** Start an MCP App's sign-in, on its server's own OAuth. */
  .post('/mcp', async (c) => {
    const { kind, returnTo } = await parseBody(c.req.raw, ConnectMcp)
    const server = connectors[kind]!.mcp!
    const state = randomBytes(24).toString('base64url')
    const verifier = pkceVerifier()
    let url: string
    try {
      url = await mcpAuthUrl(server, state, verifier)
    } catch (error) {
      throw new HTTPException(502, {
        message: `${appCatalog[kind].name} did not answer: ${error instanceof Error ? error.message : 'error'}`,
      })
    }
    await saveState(stateIdentifier(state), { ...c.var.scope, kind, returnTo, verifier })
    return c.json({ url })
  })

  /**
   * Start a GitHub connection: install Brigade's GitHub App and pick the
   * repositories. One request per member at a time.
   */
  .post('/github', async (c) => {
    if (!githubConfigured())
      throw new HTTPException(409, { message: 'GitHub is not configured on this Brigade server' })
    // The body is optional: the Connections page sends none.
    const body = ConnectGitHub.safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) throw new HTTPException(400, { message: 'Not a dashboard path' })
    const { returnTo } = body.data
    const identifier = githubPending(c.var.scope.userId)
    await prisma.verification.deleteMany({ where: { identifier } })
    await saveState(identifier, { ...c.var.scope, kind: 'github', returnTo })
    return c.json({ url: githubInstallUrl() })
  })

  /** Connect Stripe with a key entered once here. It goes straight into the vault. */
  .post('/stripe', async (c) => {
    const { scope } = c.var
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

  /**
   * A custom app that posts events to Brigade. Nothing to sign in to: its
   * triggers, added next, each carry their own URL and signing secret.
   */
  .post('/webhook', async (c) => {
    const { scope } = c.var
    const input = await parseBody(c.req.raw, ConnectWebhookApp)
    const connection = await createConnection(
      scope,
      { kind: 'webhook', label: input.label, externalAccount: null },
      null,
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

  /** Rename an account, or change where teammates may use it. */
  .patch('/:id', async (c) => {
    const { scope, db } = c.var
    const connection = await db.connection.findFirst({
      where: { id: c.req.param('id'), status: { not: 'removed' } },
    })
    if (!connection) throw new HTTPException(404, { message: 'Connection not found' })
    requireAccountManager(scope, connection)
    const input = await parseBody(c.req.raw, UpdateConnection)
    await db.connection.updateMany({ where: { id: connection.id }, data: input })
    if (connection.kind === 'webhook' && input.label)
      await db.app.updateMany({ where: { id: connection.appId }, data: { name: input.label } })
    if (input.reach && input.reach !== connection.reach)
      await audit({
        ...scope,
        actor: { type: 'member', id: scope.memberId },
        action: 'connection.reach',
        target: { type: 'connection', id: connection.id },
        data: { reach: input.reach },
      })
    return c.json({ ok: true })
  })

  /** Disconnect: revoke at the provider, delete the credential, keep the call log. */
  .delete('/:id', async (c) => {
    const { scope, db } = c.var
    const connection = await db.connection.findFirst({
      where: { id: c.req.param('id'), status: { not: 'removed' } },
    })
    if (!connection) throw new HTTPException(404, { message: 'Connection not found' })
    requireAccountManager(scope, connection)
    await disconnect(scope, db, connection)
    return c.body(null, 204)
  })

  /** Turn an App's tools on or off, for every account and teammate. */
  .patch('/apps/:id', async (c) => {
    const { scope, db } = c.var
    const app = await db.app.findFirst({
      where: { id: c.req.param('id') },
      include: { connections: { where: { status: { not: 'removed' } } } },
    })
    if (!app) throw new HTTPException(404, { message: 'App not found' })
    requireAppManager(scope, app, app.connections)
    const { disabledTools } = await parseBody(c.req.raw, UpdateApp)
    const kind = app.connections[0]?.kind ?? (app.key as ConnectorKind)
    const known = new Set(toolCatalog(kind).map((t) => t.name))
    const unknown = disabledTools.filter((t) => !known.has(t))
    if (unknown.length)
      throw new HTTPException(400, { message: `Not a tool of this App: ${unknown.join(', ')}` })
    await db.app.updateMany({ where: { id: app.id }, data: { disabledTools } })
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'app.tools',
      target: { type: 'app', id: app.id },
      data: { disabledTools },
    })
    return c.json({ ok: true })
  })

  /** Remove an App: disconnect every account in it. The App stays for the call logs. */
  .delete('/apps/:id', async (c) => {
    const { scope, db } = c.var
    const app = await db.app.findFirst({
      where: { id: c.req.param('id') },
      include: { connections: { where: { status: { not: 'removed' } } } },
    })
    if (!app) throw new HTTPException(404, { message: 'App not found' })
    requireAppManager(scope, app, app.connections)
    for (const connection of app.connections) await disconnect(scope, db, connection)
    // Its skills go with it; adding it again brings them back.
    await db.skillPack.deleteMany({ where: { appId: app.id } })
    return c.body(null, 204)
  })

/** Revoke at the provider, delete the credential, drop grants and triggers, keep the call log. */
async function disconnect(
  scope: WorkspaceScope,
  db: ScopedDb,
  connection: { id: string; kind: ConnectorKind; vaultSecretId: string | null },
) {
  // Unsubscribe at the vendor while the credential still works: Stripe endpoints, Gmail watches,
  // Calendar channels.
  await syncConnection(scope, connection.id, { removing: true }).catch((error) =>
    console.error('unsubscribe failed:', error instanceof Error ? error.message : error),
  )
  if (connection.vaultSecretId) {
    // Google and MCP tokens are revoked at the provider. A Stripe key is revoked in Stripe's
    // dashboard. A GitHub installation stays: other workspaces may use it; it is uninstalled on GitHub.
    const auth = connectors[connection.kind]?.auth
    if (auth === 'google' || auth === 'mcp') {
      const credential = await openSecret<GoogleCredential | McpCredential>(
        db,
        scope,
        connection.vaultSecretId,
      ).catch(() => null)
      if (credential && auth === 'google') await revokeGoogle(credential as GoogleCredential)
      if (credential && auth === 'mcp') await revokeMcp(credential as McpCredential)
    }
    forgetMcpTools(connection.id)
    await db.connection.updateMany({
      where: { id: connection.id },
      data: { status: 'removed', vaultSecretId: null },
    })
    await deleteSecret(db, connection.vaultSecretId)
  } else {
    await db.connection.updateMany({ where: { id: connection.id }, data: { status: 'removed' } })
  }
  await db.grant.deleteMany({ where: { connectionId: connection.id } })
  await deleteTriggers(db, { connectionId: connection.id })
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: 'connection.removed',
    target: { type: 'connection', id: connection.id },
  })
}

/**
 * Who an MCP account signed in as, to show which one it is: the server's whoami
 * tool when it has one (an email or an account name), else nothing.
 */
async function mcpAccount(url: string, credential: McpCredential) {
  try {
    const signedIn = (target: string, init: RequestInit = {}) =>
      fetch(target, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string>),
          authorization: `Bearer ${credential.accessToken}`,
        },
      })
    const output = await callMcpTool(signedIn, url, 'whoami', {})
    const who = (typeof output === 'string' ? JSON.parse(output) : output) as {
      email?: string
      name?: string
      id?: string
    }
    return who.email ?? who.name ?? who.id ?? null
  } catch {
    return null
  }
}
