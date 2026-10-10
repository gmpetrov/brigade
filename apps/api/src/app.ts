import { upgradeWebSocket } from '@hono/node-server'
import { PROTOCOL_VERSION, type HealthResponse } from '@brigade/contracts'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import { auth } from './auth.js'
import { env } from './config.js'
import { desktopProxy } from './desktop-proxy.js'
import { authenticateRunner, browserSocket, runnerSocket } from './hub.js'
import { accounts } from './routes/accounts.js'
import { attachments } from './routes/attachments.js'
import { computers, runnerLink } from './routes/computers.js'
import { connections } from './routes/connections.js'
import { credentials } from './routes/credentials.js'
import { gitProxy } from './routes/git.js'
import { githubWebhook } from './routes/github-webhook.js'
import { library } from './routes/library.js'
import { pulls } from './routes/pulls.js'
import { repositories } from './routes/repositories.js'
import { runnerAttachments } from './routes/runner-attachments.js'
import { runnerBackups } from './routes/runner-backups.js'
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
import { resolveScope } from './scope.js'

export const app = new Hono()

app.use('/api/*', cors({ origin: env.WEB_URL, credentials: true }))

app.get('/health', (c) =>
  c.json<HealthResponse>({ status: 'ok', protocolVersion: PROTOCOL_VERSION }),
)

app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))
app.route('/api', workspaces)
app.route('/api/teammates', teammates)
app.route('/api/computers', computers)
app.route('/api/accounts', accounts)
app.route('/api/connections', connections)
app.route('/api/credentials', credentials)
app.route('/api/tickets', tickets)
app.route('/api/tasks', tasks)
app.route('/api/schedules', schedules)
app.route('/api/library', library)
app.route('/api/attachments', attachments)
app.route('/api/repositories', repositories)
app.route('/api/pulls', pulls)
app.route('/api/triggers', triggers)
app.route('/api/threads', threads)
app.route('/api/search', search)
app.route('/runner', runnerLink)
app.route('/runner', runnerInstall)
app.route('/runner/library', runnerLibrary)
app.route('/runner/backups', runnerBackups)
app.route('/runner/attachments', runnerAttachments)
// Git for teammates, proxied to GitHub. Authenticated by a thread's git token, not a session.
app.route('/git', gitProxy)
// GitHub App events: pushes refresh computers' caches. Verified by the app's webhook secret.
app.route('/github/webhook', githubWebhook)
// The desktop relay. Its views are short-lived bearer ids from POST /api/threads/:id/desktop.
app.route('/desktop', desktopProxy)
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
