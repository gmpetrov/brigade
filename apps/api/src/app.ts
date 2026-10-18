import { PROTOCOL_VERSION, type HealthResponse } from '@brigade/contracts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { auth } from './auth.js'
import { apiCors } from './cors.js'
import { env } from './config.js'
import { prisma } from './db.js'
import { designFiles, sandboxHostOnlyDesigns } from './designs.js'
import { desktopProxy } from './desktop-proxy.js'
import { upgradeWebSocket } from './platform/node.js'
import { authenticateRunner, browserSocket, runnerSocket } from './hub.js'
import { accounts } from './routes/accounts.js'
import { documentAssets } from './routes/assets.js'
import { attachments } from './routes/attachments.js'
import { collab } from './routes/collab.js'
import { computers, runnerLink } from './routes/computers.js'
import { connections } from './routes/connections.js'
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
import { runnerBackups } from './routes/runner-backups.js'
import { runnerFolders } from './routes/runner-folders.js'
import { runnerLibrary } from './routes/runner-library.js'
import { schedules } from './routes/schedules.js'
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

app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))
// Brigade's OAuth client ID metadata document, read by MCP servers' authorization servers.
app.get('/api/mcp/client.json', (c) => c.json(mcpClientDocument()))
app.use('/api/connections/oauth/*', signInFirst)
app.route('/api', workspaces)
app.route('/api/teammates', teammates)
app.route('/api/computers', computers)
app.route('/api/accounts', accounts)
app.route('/api/connections', connections)
app.route('/api/credentials', credentials)
app.route('/api/security', security)
app.route('/api/tickets', tickets)
app.route('/api/tasks', tasks)
app.route('/api/schedules', schedules)
app.route('/api/projects', projects)
// Before the library: its own routes would read /assets/<id> as a file id.
app.route('/api/library/assets', documentAssets)
app.route('/api/library', library)
app.route('/api/design-systems', designSystems)
app.route('/api/skills', skills)
app.route('/api/designs', designs)
app.route('/api/attachments', attachments)
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
app.route('/runner/attachments', runnerAttachments)
app.route('/runner/skill-files', runnerSkillFiles)
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

/** The dashboard's live socket. Scoped by the session cookie. */
app.get(
  '/api/ws',
  upgradeWebSocket(async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers })
    const scope = session
      ? await resolveScope({
          userId: session.user.id,
          activeOrganizationId: session.session.activeOrganizationId ?? null,
          activeWorkspaceId:
            (session.session as { activeWorkspaceId?: string | null }).activeWorkspaceId ?? null,
        })
      : null
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
  upgradeWebSocket(async (c) => {
    const runner = await authenticateRunner(c.req.header('authorization'))
    if (!runner) return { onOpen: (_e, ws) => ws.close(4401, 'unknown runner token') }
    const socket = runnerSocket(runner)
    return {
      onMessage: (e, ws) => socket.onMessage(e.data, ws),
      onClose: () => socket.onClose(),
    }
  }),
)

app.onError((error, c) => {
  if (error instanceof HTTPException) return c.json({ error: error.message }, error.status)
  console.error(error)
  return c.json({ error: 'Internal error' }, 500)
})
