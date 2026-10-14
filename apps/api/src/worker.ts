// The API on Cloudflare Workers. One Durable Object, `Api`, runs the whole API,
// as the one Node process does on a server (src/index.ts): the WebSocket hub
// keeps every runner's and dashboard's socket in its memory, so every request
// goes to that one object. In production a small Worker forwards requests to it
// (src/front.ts); this one's fetch does the same under `wrangler dev`. This one
// also wakes it each minute so its jobs (schedules, inboxes, idle computers) run
// while nobody is connected.
//
// The API itself loads only in the object, on first use: this Worker's own isolates
// then start without evaluating the whole app (281 ms at deploy, with Prisma).
import './worker-env.js'
import { DurableObject } from 'cloudflare:workers'
import { apiObject, NAME } from './api-object.js'

type Env = {
  API: DurableObjectNamespace<Api>
}

export class Api extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // An object left behind under an earlier name runs no jobs, should anything wake it.
    if ((ctx.id.name ?? NAME) === NAME) void import('./jobs.js').then((jobs) => jobs.startJobs())
  }

  override async fetch(request: Request) {
    const { app } = await import('./app.js')
    return app.fetch(request)
  }

  /** Keeps the object up (src/jobs.ts runs in it). */
  ping() {
    return true
  }
}

export default {
  fetch(request, env) {
    return apiObject(env.API).fetch(request)
  },
  async scheduled(_controller, env) {
    await apiObject(env.API, 'weur').ping()
  },
} satisfies ExportedHandler<Env>
