import { PROTOCOL_VERSION, type HealthResponse } from '@brigade/contracts'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { HTTPException } from 'hono/http-exception'
import { auth } from './auth.js'
import { checkoutReturn, stripeWebhook } from './billing.js'
import { apiCors } from './cors.js'
import { env } from './config.js'
import { prisma } from './db.js'
import { designFiles, sandboxHostOnlyDesigns } from './designs.js'
import { desktopProxy } from './desktop-proxy.js'
import { hubIsElsewhere, moveHub, upgradeWebSocket } from './platform/node.js'
import { HUB_HEADER, MISDIRECTED, WORKSPACE_HEADER } from './hub/route.js'
import { authenticateRunner, browserSocket, runnerSocket } from './hub.js'
import { accounts } from './routes/accounts.js'
import { documentAssets } from './routes/assets.js'
import { attachments } from './routes/attachments.js'
import { localBucket } from './routes/bucket.js'
import { billing } from './routes/billing.js'
import { usage } from './routes/usage.js'
import { collab } from './routes/collab.js'
import { computers, runnerLink } from './routes/computers.js'
import { connections } from './routes/connections.js'
import { email } from './routes/email.js'
import { inbox } from './routes/inbox.js'
import { credentials } from './routes/credentials.js'
import { designs, designSystems } from './routes/designs.js'
import { security } from './routes/security.js'
import { skills } from './routes/skills.js'
import { gitProxy } from './routes/git.js'
import { githubWebhook } from './routes/github-webhook.js'
import { library } from './routes/library.js'
import { notifications } from './routes/notifications.js'
import { projects } from './routes/projects.js'
import { home } from './routes/home.js'
import { pulls } from './routes/pulls.js'
import { repositories } from './routes/repositories.js'
import { runnerAttachments } from './routes/runner-attachments.js'
import { runnerSkillFiles } from './routes/runner-skill-files.js'
import { runnerCatalogs } from './routes/runner-catalogs.js'
import { runnerSpecParts } from './routes/runner-spec-parts.js'
import { runnerBackups } from './routes/runner-backups.js'
import { runnerFiles } from './routes/runner-files.js'
import { runnerUploads } from './routes/runner-uploads.js'
import { uploads } from './routes/uploads.js'
import { runnerFolders } from './routes/runner-folders.js'
import { runnerComputer } from './routes/runner-computer.js'
import { runnerLibrary } from './routes/runner-library.js'
import { schedules } from './routes/schedules.js'
import { playbooks } from './routes/playbooks.js'
import { search } from './routes/search.js'
import { tasks } from './routes/tasks.js'
import { tickets } from './routes/tickets.js'
import { customApps, events } from './routes/events.js'
import { triggers } from './routes/triggers.js'
import { runnerInstall } from './routes/runner-install.js'
import { teammates } from './routes/teammates.js'
import { threads } from './routes/threads.js'
import { workspaces } from './routes/workspaces.js'
import { mcpClientDocument } from './connectors/mcp.js'
import { resolveScope, signInFirst } from './scope.js'
import { serverTiming } from './timing.js'
import { noteFailure } from './ops/failures.js'
import { openAlerts } from './ops/alerts.js'
import { safeEqual } from './ops/send.js'

export const app = new Hono()

app.use(serverTiming)
app.use(sandboxHostOnlyDesigns)
app.use('/api/*', apiCors(env.WEB_URL))

app.get('/health', (c) =>
  c.json<HealthResponse>({
    status: 'ok',
    protocolVersion: PROTOCOL_VERSION,
    build: process.env.BRIGADE_BUILD_ID || undefined,
  }),
)

/**
 * How far the database is from where the API runs: three `SELECT 1` in a row, and the
 * Cloudflare data center its requests leave from (on Workers, where the Api object is).
 */
app.get('/health/db', async (c) => {
  const queryMs: number[] = []
  for (let i = 0; i < 3; i++) {
    const start = performance.now()
    await prisma.$queryRaw`SELECT 1`
    queryMs.push(Math.round(performance.now() - start))
  }
  const trace = await fetch('https://www.cloudflare.com/cdn-cgi/trace').then(
    (r) => r.text(),
    () => '',
  )
  return c.json({ queryMs, colo: /^colo=(\w+)$/m.exec(trace)?.[1] ?? null })
})

/**
 * What is wrong with Brigade now (src/ops/), for an uptime monitor outside Cloudflare: 200
 * when nothing critical is open, else 503. Needs OPS_TOKEN as a bearer token.
 */
app.get('/health/ops', async (c) => {
  const token = c.req.header('authorization')?.replace(/^Bearer /, '') ?? ''
  if (!env.OPS_TOKEN || !safeEqual(token, env.OPS_TOKEN)) return c.json({ error: 'Not found' }, 404)
  const alerts = await openAlerts()
  const { lastChecksAt } = await import('./ops/checks.js')
  return c.json(
    { checksAt: lastChecksAt ? new Date(lastChecksAt).toISOString() : null, alerts },
    alerts.some((a) => a.severity === 'critical') ? 503 : 200,
  )
})

/**
 * Where a workspace's hub runs on Cloudflare (docs/workspace-hubs-plan.md): POST {workspaceId,
 * mode: 'object' | 'api'}. Its sockets on the side it leaves close and connect again where it is.
 * Needs OPS_TOKEN as a bearer token.
 */
app.post('/ops/hubs', async (c) => {
  const token = c.req.header('authorization')?.replace(/^Bearer /, '') ?? ''
  if (!env.OPS_TOKEN || !safeEqual(token, env.OPS_TOKEN)) return c.json({ error: 'Not found' }, 404)
  const input = z
    .object({ workspaceId: z.string().min(1), mode: z.enum(['api', 'object']) })
    .safeParse(await c.req.json().catch(() => null))
  if (!input.success)
    return c.json({ error: 'Expected { workspaceId, mode: "api" | "object" }' }, 400)
  const workspace = await prisma.workspace.findUnique({ where: { id: input.data.workspaceId } })
  if (!workspace) return c.json({ error: 'No such workspace' }, 404)
  await moveHub(input.data.workspaceId, input.data.mode)
  console.log(`hub of ${input.data.workspaceId} moved to ${input.data.mode}`)
  return c.json({ workspaceId: input.data.workspaceId, mode: input.data.mode })
})

app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))
// Billing (src/billing.ts): Stripe's webhook, verified by its signature, and the way back
// from Checkout, which reads only Stripe. Neither needs a session: before the routers below,
// whose middleware asks for one.
app.post('/api/billing/webhook', (c) => stripeWebhook(c.req.raw))
app.get('/api/billing/return', async (c) => {
  await checkoutReturn(c.req.query('session')).catch((error) =>
    // The webhook does it, a moment later.
    console.error('billing: reconciling on the way back from Checkout failed', error),
  )
  const page = c.req.query('to') === 'onboarding' ? '/onboarding' : '/app/billing'
  return c.redirect(`${env.WEB_URL[0]}${page}?subscribed=1`)
})
// Brigade's OAuth client ID metadata document, read by MCP servers' authorization servers.
app.get('/api/mcp/client.json', (c) => c.json(mcpClientDocument()))
app.use('/api/connections/oauth/*', signInFirst)
// The bucket's stand-in for uploads without R2 (development): signed paths, no session.
app.route('/api/bucket', localBucket)
app.route('/api', workspaces)
app.route('/api/teammates', teammates)
app.route('/api/computers', computers)
app.route('/api/billing', billing)
app.route('/api/accounts', accounts)
app.route('/api/usage', usage)
app.route('/api/connections', connections)
app.route('/api/email', email)
app.route('/api/inbox', inbox)
app.route('/api/credentials', credentials)
app.route('/api/security', security)
app.route('/api/tickets', tickets)
app.route('/api/tasks', tasks)
app.route('/api/schedules', schedules)
app.route('/api/playbooks', playbooks)
app.route('/api/projects', projects)
// Before the library: its own routes would read /assets/<id> as a file id.
app.route('/api/library/assets', documentAssets)
app.route('/api/library', library)
app.route('/api/design-systems', designSystems)
app.route('/api/skills', skills)
app.route('/api/designs', designs)
app.route('/api/attachments', attachments)
app.route('/api/uploads', uploads)
app.route('/api/repositories', repositories)
app.route('/api/home', home)
app.route('/api/pulls', pulls)
app.route('/api/triggers', triggers)
app.route('/api/threads', threads)
app.route('/api/search', search)
app.route('/api/notifications', notifications)
app.route('/runner', runnerLink)
app.route('/runner', runnerInstall)
app.route('/runner/library', runnerLibrary)
app.route('/runner/backups', runnerBackups)
app.route('/runner/folders', runnerFolders)
app.route('/runner/computer', runnerComputer)
app.route('/runner/files', runnerFiles)
app.route('/runner/uploads', runnerUploads)
app.route('/runner/attachments', runnerAttachments)
app.route('/runner/skill-files', runnerSkillFiles)
app.route('/runner/spec-parts', runnerSpecParts)
app.route('/runner/catalogs', runnerCatalogs)
// Git for teammates, proxied to GitHub. Authenticated by a thread's git token, not a session.
app.route('/git', gitProxy)
// GitHub App events: pushes refresh computers' caches. Verified by the app's webhook secret.
app.route('/github/webhook', githubWebhook)
// The desktop relay. Its views are short-lived bearer ids from POST /api/threads/:id/desktop.
app.route('/desktop', desktopProxy)
// Designs' pages, on the sandbox origin (DESIGN_URL). Their addresses are signed and short-lived.
app.route('/v', designFiles)
// The collab server's calls: documents people edit together. Verified by COLLAB_SECRET.
app.route('/collab', collab)
// Public: vendors deliver events here (Stripe, Gmail's Pub/Sub, Calendar channels), and
// custom apps post to their triggers' URLs. Each verified, without a session.
app.route('/events', events)
app.route('/hooks', customApps)

/** The workspace a dashboard's socket is for: the session's, or the one it names, if a member's. */
async function socketScope(c: Context) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session) return null
  const named = c.req.query('workspace')
  const workspace = named
    ? await prisma.workspace.findUnique({ where: { id: named }, select: { organizationId: true } })
    : null
  return resolveScope({
    userId: session.user.id,
    activeOrganizationId: workspace?.organizationId ?? session.session.activeOrganizationId ?? null,
    activeWorkspaceId: workspace
      ? named!
      : ((session.session as { activeWorkspaceId?: string | null }).activeWorkspaceId ?? null),
  })
}

/**
 * A socket of a workspace whose hub has a Durable Object of its own (docs/workspace-hubs-plan.md)
 * is not this process's: the API's front sends it there (src/front.ts). Never on Node.
 */
async function hubElsewhere(c: Context, workspaceId: string | undefined) {
  if (!workspaceId || !(await hubIsElsewhere(workspaceId))) return null
  return c.body('This workspace’s hub has its own object', MISDIRECTED, {
    [HUB_HEADER]: 'object',
    [WORKSPACE_HEADER]: workspaceId,
  })
}

/** The dashboard's live socket. Scoped by the session cookie. */
app.get(
  '/api/ws',
  async (c, next) => (await hubElsewhere(c, (await socketScope(c))?.workspaceId)) ?? next(),
  upgradeWebSocket(async (c) => {
    const scope = await socketScope(c)
    if (!scope) return { onOpen: (_e, ws) => ws.close(4401, 'unauthorized') }
    const socket = browserSocket(scope)
    return {
      onOpen: (_e, ws) => socket.onOpen(ws),
      onMessage: (e, ws) => void socket.onMessage(e.data, ws),
      onClose: () => socket.onClose(),
    }
  }),
)

/** The one outbound socket from each runner. Scoped by the runner token. */
app.get(
  '/runner/ws',
  async (c, next) =>
    (await hubElsewhere(
      c,
      (await authenticateRunner(c.req.header('authorization')))?.workspaceId,
    )) ?? next(),
  upgradeWebSocket(async (c) => {
    const runner = await authenticateRunner(c.req.header('authorization'))
    if (!runner) return { onOpen: (_e, ws) => ws.close(4401, 'unknown runner token') }
    const socket = runnerSocket(runner)
    return {
      onOpen: (_e, ws) => socket.onOpen(ws),
      onMessage: (e, ws) => void socket.onMessage(e.data, ws),
      onClose: () => socket.onClose(),
    }
  }),
)

app.onError((error, c) => {
  if (error instanceof HTTPException) return c.json({ error: error.message }, error.status)
  console.error(`${c.req.method} ${c.req.path} failed:`, error)
  noteFailure(
    'api',
    `${c.req.method} ${c.req.routePath}: ${error instanceof Error ? error.message : String(error)}`,
  )
  return c.json({ error: 'Internal error' }, 500)
})
