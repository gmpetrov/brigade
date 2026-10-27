// The API's front door on Cloudflare, the Worker brigade-api-front: it forwards each
// request to the Api object, which runs the whole API in the Worker brigade-api
// (src/worker.ts), and each runner's and dashboard's socket to its workspace's hub: the
// Api object's, or the workspace's own hub object (src/hub-object.ts) once its hubMode
// is 'object' (docs/workspace-hubs-plan.md). It is a Worker of its own to stay small. A
// new connection can land on a machine that has not loaded the Worker yet: loading
// brigade-api's 13 MB there made a connection's first request 0.3 to 0.6 s slower, and
// each WebSocket has a connection of its own. This one loads at once.
//
// Browsers' preflights for the API it answers itself, as the API would (src/cors.ts):
// forwarded, each crossed to the object in Frankfurt and back before the write it asks
// about could leave, one more trip (about 200 ms from Los Angeles).
import { Hono } from 'hono/tiny'
import { apiObject } from './api-object.js'
import { apiCors } from './cors.js'
import { HUB_HEADER, MISDIRECTED, WORKSPACE_HEADER, workspaceOfSocket } from './hub/route.js'
import type { WorkspaceHubObject } from './hub-object.js'
import type { Api } from './worker.js'

type Env = {
  API: DurableObjectNamespace<Api>
  /** The workspaces' hub objects, in brigade-api; unset, every socket goes to the Api object. */
  HUBS?: DurableObjectNamespace<WorkspaceHubObject>
  /** The dashboard's origins, comma-separated: brigade-api's WEB_URL (wrangler.front.jsonc). */
  WEB_URL: string
}

const origins = (list: string) =>
  list
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)

const preflights = new Hono<{ Bindings: Env }>().options('/api/*', (c, next) =>
  apiCors(origins(c.env.WEB_URL))(c, next),
)

/** Where each workspace's sockets went lately, in this isolate: so most go there at once. */
const ROUTE_MS = 30_000
const routes = new Map<string, { to: 'api' | 'object'; at: number }>()

const remember = (workspaceId: string, to: 'api' | 'object') => {
  if (routes.size > 10_000) routes.clear()
  routes.set(workspaceId, { to, at: Date.now() })
}

/** The request again, as the given workspace's: a body-less upgrade can be sent more than once. */
function named(request: Request, workspaceId?: string) {
  const url = new URL(request.url)
  if (workspaceId) url.searchParams.set('workspace', workspaceId)
  return new Request(url, request)
}

/**
 * A runner's or a dashboard's socket. To its workspace's hub object, unless the workspace's
 * sockets went to the Api object lately; the object that does not hold them answers 421 and says
 * where they go, and the socket goes there. A socket that names no workspace (a runner linked
 * before tokens named it, a dashboard before it knew its workspace) goes to the Api object, which
 * finds the workspace and says so when its hub is an object.
 */
async function socket(
  request: Request,
  env: Env & { HUBS: DurableObjectNamespace<WorkspaceHubObject> },
) {
  const hub = (workspaceId: string) =>
    env.HUBS.get(env.HUBS.idFromName(workspaceId), { locationHint: 'weur' }).fetch(
      named(request, workspaceId),
    )
  const api = () => apiObject(env.API).fetch(named(request))
  const workspaceId = workspaceOfSocket(request)
  const known = workspaceId ? routes.get(workspaceId) : undefined
  if (!workspaceId || (known?.to === 'api' && Date.now() - known.at < ROUTE_MS)) {
    const answer = await api()
    const elsewhere = answer.status === MISDIRECTED && answer.headers.get(HUB_HEADER) === 'object'
    const owner = answer.headers.get(WORKSPACE_HEADER) ?? workspaceId
    if (!elsewhere || !owner) return answer
    remember(owner, 'object')
    return hub(owner)
  }
  const answer = await hub(workspaceId)
  if (answer.status === MISDIRECTED && answer.headers.get(HUB_HEADER) === 'api') {
    remember(workspaceId, 'api')
    return api()
  }
  remember(workspaceId, 'object')
  return answer
}

export default {
  fetch(request, env) {
    const { pathname } = new URL(request.url)
    if (request.method === 'OPTIONS' && pathname.startsWith('/api/'))
      return preflights.fetch(request, env)
    if (
      env.HUBS &&
      request.headers.get('upgrade') === 'websocket' &&
      (pathname === '/runner/ws' || pathname === '/api/ws')
    )
      return socket(request, { ...env, HUBS: env.HUBS })
    return apiObject(env.API).fetch(request)
  },
} satisfies ExportedHandler<Env>
