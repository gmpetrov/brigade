// The API's front door on Cloudflare, the Worker brigade-api-front: it forwards each
// request to the Api object, which runs the whole API in the Worker brigade-api
// (src/worker.ts). It is a Worker of its own to stay small. A new connection can land on
// a machine that has not loaded the Worker yet: loading brigade-api's 13 MB there made
// a connection's first request 0.3 to 0.6 s slower, and each WebSocket has a connection
// of its own. This one loads at once.
//
// Browsers' preflights for the API it answers itself, as the API would (src/cors.ts):
// forwarded, each crossed to the object in Frankfurt and back before the write it asks
// about could leave, one more trip (about 200 ms from Los Angeles).
import { Hono } from 'hono/tiny'
import { apiObject } from './api-object.js'
import { apiCors } from './cors.js'
import type { Api } from './worker.js'

type Env = {
  API: DurableObjectNamespace<Api>
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

export default {
  fetch(request, env) {
    if (request.method === 'OPTIONS' && new URL(request.url).pathname.startsWith('/api/'))
      return preflights.fetch(request, env)
    return apiObject(env.API).fetch(request)
  },
} satisfies ExportedHandler<Env>
