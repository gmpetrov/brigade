// The API's front door on Cloudflare, the Worker brigade-api-front: it forwards each
// request to the Api object, which runs the whole API in the Worker brigade-api
// (src/worker.ts). It is a Worker of its own to stay small. A new connection can land on
// a machine that has not loaded the Worker yet: loading brigade-api's 13 MB there made
// a connection's first request 0.3 to 0.6 s slower, and each WebSocket has a connection
// of its own. This one loads at once.
import { apiObject } from './api-object.js'
import type { Api } from './worker.js'

type Env = {
  API: DurableObjectNamespace<Api>
}

export default {
  fetch(request, env) {
    return apiObject(env.API).fetch(request)
  },
} satisfies ExportedHandler<Env>
