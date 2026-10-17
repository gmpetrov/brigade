import { randomBytes, randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { audit } from '../audit.js'
import { env } from '../config.js'
import { appCatalog, connectors, mcpToolName, toolCatalog } from '../connectors/index.js'
import {
  ConnectGitHub,
  ConnectGoogle,
  ConnectMcp,
  ConnectMcpServer,
  ConnectStripe,
  InspectMcp,
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
  googleMcpConfigured,
  revokeGoogle,
  type GoogleCredential,
} from '../connectors/google-oauth.js'
import {
  callMcpTool,
  exchangeMcpCode,
  inspectMcp,
  listMcpTools,
  mcpAuthUrl,
  mcpRedirectUri,
  mcpServerInfo,
  pkceVerifier,
  revokeMcp,
  type McpCredential,
  type McpOAuthClient,
} from '../connectors/mcp.js'
import type { McpServer } from '../connectors/types.js'
import {
  asServer,
  catalogTools,
  customMcp,
  mcpAppKey,
  normalUrl,
  toolPrefix,
  type CustomMcp,
} from '../mcp-servers.js'
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
  kind:
    | 'gmail'
    | 'google_calendar'
    | 'github'
    | 'cloudflare'
    | 'google_cloud'
    | 'neon'
    | 'supabase'
    | 'mcp'
  /** mcp: the App of the server added by its URL. */
  appId?: string
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
  /** An MCP server added by its URL: its App, added before its first account signs in. */
  existing?: { id: string },
) {
  const db = scoped(scope)
  const vaultSecretId = credential ? await sealSecret(db, scope, credential) : null
  const id = randomUUID()
  const custom = connection.kind === 'webhook'
  const app =
    existing ??
    (await appFor(db, scope, appKey(connection.kind, id), custom ? connection.label : null))
  const row = await db.connection.create({
    data: {
      ...connection,
      id,
      appId: app.id,
      // A server with nothing to sign in to is nobody's own account.
      reach: appCatalog[connection.kind].personal && credential ? 'mine' : 'workspace',
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
    const db = scoped(scope)
    // A server added by its URL, from its App; else a built-in App's.
    const added =
      grant.kind === 'mcp' && grant.appId
        ? await db.app.findFirst({ where: { id: grant.appId } })
        : null
    const config = added ? customMcp(added) : null
    const server = config ? asServer(config) : connectors[grant.kind]?.mcp
    if (!server || !grant.verifier || (grant.kind === 'mcp' && !added))
      return back('error=forbidden')
    if (c.req.query('error') || !c.req.query('code')) return back('error=declined')

    let credential: McpCredential
    let email: string | null
    try {
      const own = config ? await ownClient(db, scope, config) : undefined
      ;({ credential, email } = await exchangeMcpCode(
        server,
        c.req.query('code')!,
        grant.verifier,
        own,
      ))
    } catch (error) {
      console.error('mcp connection failed:', error instanceof Error ? error.message : error)
      return back('error=mcp')
    }
    const signedIn = bearer(credential.accessToken)
    const account = email ?? (await mcpAccount(server, signedIn))
    const kind = grant.kind as ConnectorKind
    const connection = await createConnection(
      scope,
      { kind, label: added?.name ?? appCatalog[kind].name, externalAccount: account },
      credential,
      added ?? undefined,
    )
    if (added && config) await refreshApp(db, added.id, config, server, signedIn)
    const repository = appCatalog[kind].skills
    if (repository) {
      const has = await db.skillPack.count({ where: { appId: connection.appId } })
      if (!has)
        await installAppSkills(
          db,
          scope,
          { type: 'member', id: scope.memberId },
          { id: connection.appId, name: appCatalog[kind].name },
          repository,
        )
          .then(({ skipped }) => {
            if (skipped.length)
              console.warn(`app skills left out: ${skipped.map((s) => s.name).join(', ')}`)
          })
          .catch((error) =>
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
        mcp: mcpView(customMcp(a)),
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
        google_cloud: googleMcpConfigured(),
        neon: true,
        supabase: true,
        mcp: true,
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

  /**
   * What an MCP server is and how its accounts sign in, from its URL alone: the dashboard
   * shows it as a card before anyone signs in, with only the fields its sign-in needs.
   */
  .post('/mcp/inspect', async (c) => {
    const { url } = await parseBody(c.req.raw, InspectMcp)
    let inspection: Awaited<ReturnType<typeof inspectMcp>>
    try {
      inspection = await inspectMcp(url)
    } catch (error) {
      throw new HTTPException(400, {
        message: error instanceof Error ? error.message : 'Not an MCP server',
      })
    }
    const app = await c.var.db.app.findFirst({
      where: {
        key: mcpAppKey(inspection.url),
        connections: { some: { status: { not: 'removed' } } },
      },
    })
    return c.json({
      ...inspection,
      app: app ? { id: app.id, name: app.name ?? inspection.name } : null,
      redirectUri: mcpRedirectUri(),
    })
  })

  /**
   * An account on an MCP server added by its URL. Adds its App the first time, then
   * signs in the way the server asks: its OAuth (the provider's page, in a window of
   * its own), a key the member pasted (checked against the server), or nothing.
   */
  .post('/mcp/server', async (c) => {
    const { scope, db } = c.var
    const input = await parseBody(c.req.raw, ConnectMcpServer)
    const app = await mcpApp(db, scope, input)
    const config = customMcp(app)!
    const server = asServer(config)
    const name = app.name ?? 'MCP server'
    const label = { kind: 'mcp' as const, label: name }

    if (config.auth === 'none') {
      // Nothing to sign in to: one account, for every teammate given it.
      const existing = await db.connection.findFirst({
        where: { appId: app.id, status: { not: 'removed' } },
      })
      if (existing) return c.json({ id: existing.id, appId: app.id }, 200)
      const plain = (url: string, init?: RequestInit) => fetch(url, init)
      const connection = await createConnection(
        scope,
        { ...label, externalAccount: null },
        null,
        app,
      )
      await refreshApp(db, app.id, config, server, plain)
      return c.json({ id: connection.id, appId: app.id }, 201)
    }

    if (config.auth === 'api_key') {
      if (!input.apiKey) throw new HTTPException(400, { message: 'Paste the key for this server' })
      const header = config.header
        ? { [config.header]: input.apiKey }
        : { authorization: `Bearer ${input.apiKey}` }
      const keyed = (url: string, init: RequestInit = {}) =>
        fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), ...header } })
      try {
        await listMcpTools(keyed, server)
      } catch (error) {
        throw new HTTPException(400, {
          message: `${name} did not accept that key (${error instanceof Error ? error.message : 'error'})`,
        })
      }
      const connection = await createConnection(
        scope,
        { ...label, externalAccount: await mcpAccount(server, keyed) },
        { apiKey: input.apiKey },
        app,
      )
      await refreshApp(db, app.id, config, server, keyed)
      return c.json({ id: connection.id, appId: app.id }, 201)
    }

    // OAuth: the provider's own sign-in page.
    const state = randomBytes(24).toString('base64url')
    const verifier = pkceVerifier()
    let url: string
    try {
      url = await mcpAuthUrl(server, state, verifier, await ownClient(db, scope, config))
    } catch (error) {
      throw new HTTPException(502, {
        message: `${name} did not answer: ${error instanceof Error ? error.message : 'error'}`,
      })
    }
    await saveState(stateIdentifier(state), {
      ...scope,
      kind: 'mcp',
      appId: app.id,
      returnTo: input.returnTo,
      verifier,
    })
    return c.json({ url, appId: app.id })
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
    const known = new Set(
      (customMcp(app)?.tools ?? toolCatalog(kind)).map((t: { name: string }) => t.name),
    )
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

  /**
   * Add (or update) the skills that come with an App, e.g. when they did not come
   * with its first account. Says which were left out and why.
   */
  .post('/apps/:id/skills', async (c) => {
    const { scope, db } = c.var
    const app = await db.app.findFirst({
      where: { id: c.req.param('id') },
      include: { connections: { where: { status: { not: 'removed' } } } },
    })
    if (!app) throw new HTTPException(404, { message: 'App not found' })
    requireAppManager(scope, app, app.connections)
    const kind = (app.connections[0]?.kind ?? app.key) as ConnectorKind
    const repository = appCatalog[kind]?.skills
    if (!repository) throw new HTTPException(400, { message: 'This App has no skills' })
    let result: Awaited<ReturnType<typeof installAppSkills>>
    try {
      result = await installAppSkills(
        db,
        scope,
        { type: 'member', id: scope.memberId },
        { id: app.id, name: appCatalog[kind].name },
        repository,
      )
    } catch (error) {
      throw new HTTPException(502, {
        message: `The skills could not be read from ${repository}: ${error instanceof Error ? error.message : 'error'}`,
      })
    }
    if (result.added === 0)
      throw new HTTPException(409, {
        message: `None of its skills could be added: ${result.skipped
          .slice(0, 5)
          .map((s) => `${s.name} (${s.problem})`)
          .join(', ')}${result.skipped.length > 5 ? '…' : ''}`,
      })
    return c.json(result)
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
    // So does the OAuth client a member gave for its server: adding it again asks again.
    const config = customMcp(app)
    if (config?.client) {
      if (config.client.secretId) await deleteSecret(db, config.client.secretId)
      const { client: _client, ...rest } = config
      await db.app.updateMany({ where: { id: app.id }, data: { mcp: rest } })
    }
    return c.body(null, 204)
  })

/** Revoke at the provider, delete the credential, drop grants and triggers, keep the call log. */
async function disconnect(
  scope: WorkspaceScope,
  db: ScopedDb,
  connection: { id: string; kind: ConnectorKind; vaultSecretId: string | null; appId: string },
) {
  // Unsubscribe at the vendor while the credential still works: Stripe endpoints, Gmail watches,
  // Calendar channels.
  await syncConnection(scope, connection.id, { removing: true }).catch((error) =>
    console.error('unsubscribe failed:', error instanceof Error ? error.message : error),
  )
  if (connection.vaultSecretId) {
    // Google and MCP tokens are revoked at the provider. A Stripe key is revoked in Stripe's
    // dashboard. A GitHub installation stays: other workspaces may use it; it is uninstalled on GitHub.
    const auth =
      connection.kind === 'mcp'
        ? customMcp((await db.app.findFirst({ where: { id: connection.appId } })) ?? {})?.auth ===
          'oauth'
          ? 'mcp'
          : 'api_key'
        : connectors[connection.kind]?.auth
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

/** A fetch that sends an access token. */
const bearer =
  (token: string) =>
  (target: string, init: RequestInit = {}) =>
    fetch(target, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` },
    })

/**
 * Who an MCP account signed in as, to show which one it is: the tool its App names
 * (Neon's and Supabase's organizations), else the server's whoami tool when it has one
 * (an email or an account name), else nothing.
 */
async function mcpAccount(server: McpServer, signedIn: typeof fetch | ReturnType<typeof bearer>) {
  try {
    if (server.account) {
      const output = await callMcpTool(signedIn, server, server.account.tool, {})
      return server.account.name(typeof output === 'string' ? JSON.parse(output) : output)
    }
    const output = await callMcpTool(signedIn, server, 'whoami', {})
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

/** An App's MCP server as the dashboard shows it: never its client's secret. */
function mcpView(config: CustomMcp | null) {
  if (!config) return null
  return {
    url: config.url,
    auth: config.auth,
    transport: config.transport,
    header: config.header ?? null,
    clientId: config.client?.id ?? null,
    icons: config.icons,
    description: config.description,
    tools: config.tools,
  }
}

/** The client a member registered at the provider for this server, with its secret. */
async function ownClient(
  db: ScopedDb,
  scope: WorkspaceScope,
  config: CustomMcp,
): Promise<McpOAuthClient | undefined> {
  if (!config.client) return undefined
  const secret = config.client.secretId
    ? await openSecret<{ clientSecret: string }>(db, scope, config.client.secretId)
    : null
  return { clientId: config.client.id, clientSecret: secret?.clientSecret ?? null }
}

/**
 * The App of an MCP server added by its URL, as the member's request needs it: the one
 * named, or the one for that URL (added the first time, its server inspected again here
 * rather than trusted from the dashboard). A client the member gives is kept with it.
 */
async function mcpApp(
  db: ScopedDb,
  scope: WorkspaceScope,
  input: {
    url?: string
    appId?: string
    name?: string
    header?: string
    apiKey?: string
    clientId?: string
    clientSecret?: string
  },
) {
  if (input.appId) {
    const app = await db.app.findFirst({ where: { id: input.appId } })
    if (!app || !customMcp(app))
      throw new HTTPException(404, { message: 'That MCP server is not in this workspace' })
    return withClient(db, scope, app, input)
  }
  let inspection: Awaited<ReturnType<typeof inspectMcp>>
  try {
    inspection = await inspectMcp(input.url!)
  } catch (error) {
    throw new HTTPException(400, {
      message: error instanceof Error ? error.message : 'Not an MCP server',
    })
  }
  // A server that registers no OAuth client often takes a token too (GitHub's, a personal one).
  const byKey =
    inspection.signIn === 'api_key' || (inspection.signIn === 'oauth_client' && !!input.apiKey)
  if (inspection.signIn === 'oauth_client' && !input.clientId && !byKey)
    throw new HTTPException(400, {
      message: `${inspection.name} needs an OAuth client: register one with its provider and enter its client ID, or paste a token`,
    })
  const key = mcpAppKey(inspection.url)
  const existing = await db.app.findFirst({
    where: { key },
    include: { connections: { where: { status: { not: 'removed' } } } },
  })
  if (existing && existing.connections.length > 0 && customMcp(existing))
    return withClient(db, scope, existing, input)
  // Not added yet, or every account of it was removed: set it up as this member asks.
  const others = await db.app.findMany({ where: { key: { startsWith: 'mcp:' } } })
  const name = input.name ?? inspection.name
  const prior = existing ? customMcp(existing) : null
  // Kept from before, so the names of tools turned off still match.
  const prefix =
    prior?.prefix ??
    toolPrefix(
      name,
      others.flatMap((a) => customMcp(a)?.prefix ?? []),
    )
  const config: CustomMcp = {
    url: normalUrl(inspection.url),
    transport: inspection.transport,
    auth: inspection.signIn === 'none' ? 'none' : byKey ? 'api_key' : 'oauth',
    ...(byKey && input.header ? { header: input.header } : {}),
    // The member kept the name Brigade guessed from the host: the server may say its own later.
    ...(inspection.signIn !== 'none' && (!input.name || input.name === inspection.name)
      ? { guessedName: true }
      : {}),
    prefix,
    icons: inspection.icons,
    description: inspection.description,
    tools: inspection.tools
      ? inspection.tools.map((t) => ({ ...t, name: mcpToolName(prefix, t.name) }))
      : (prior?.tools ?? []),
  }
  const app = existing
    ? await db.app
        .updateMany({
          where: { id: existing.id },
          data: { name, mcp: config, createdByMemberId: scope.memberId },
        })
        .then(() => db.app.findFirstOrThrow({ where: { id: existing.id } }))
    : await appFor(db, scope, key, name).then(async (added) => {
        await db.app.updateMany({ where: { id: added.id }, data: { name, mcp: config } })
        return db.app.findFirstOrThrow({ where: { id: added.id } })
      })
  return withClient(db, scope, app, input)
}

/** Keep the OAuth client a member gave with the App (its secret in the vault). */
async function withClient<A extends { id: string; mcp: unknown }>(
  db: ScopedDb,
  scope: WorkspaceScope,
  app: A,
  input: { clientId?: string; clientSecret?: string },
) {
  const config = customMcp(app)!
  if (!input.clientId || config.auth !== 'oauth') return app
  if (config.client?.secretId) await deleteSecret(db, config.client.secretId)
  const secretId = input.clientSecret
    ? await sealSecret(db, scope, { clientSecret: input.clientSecret })
    : undefined
  const mcp: CustomMcp = {
    ...config,
    client: { id: input.clientId, ...(secretId ? { secretId } : {}) },
  }
  await db.app.updateMany({ where: { id: app.id }, data: { mcp } })
  return { ...app, mcp }
}

/**
 * Once an account works: the server's tools for the App's switches, and its own icon
 * when it shows one only to signed-in accounts.
 */
async function refreshApp(
  db: ScopedDb,
  appId: string,
  config: CustomMcp,
  server: McpServer,
  signedIn: (url: string, init?: RequestInit) => Promise<Response>,
) {
  try {
    const [tools, info] = await Promise.all([
      listMcpTools(signedIn, server),
      mcpServerInfo(signedIn, server).catch(() => null),
    ])
    const icons =
      info?.icon && !config.icons.includes(info.icon) ? [info.icon, ...config.icons] : config.icons
    const { guessedName: _guessed, ...rest } = config
    const named = config.guessedName && info?.name ? info.name.slice(0, 80) : null
    if (named) {
      // Its accounts were labelled with the guess too.
      const app = await db.app.findFirst({ where: { id: appId } })
      if (app?.name)
        await db.connection.updateMany({
          where: { appId, label: app.name },
          data: { label: named },
        })
    }
    await db.app.updateMany({
      where: { id: appId },
      data: {
        ...(named ? { name: named } : {}),
        mcp: { ...(named ? rest : config), icons, tools: catalogTools(config.prefix, tools) },
      },
    })
  } catch (error) {
    console.warn('mcp tools not listed:', error instanceof Error ? error.message : error)
  }
}
