// The API on Cloudflare Workers. One Durable Object, `Api`, runs the whole API,
// as the one Node process does on a server (src/index.ts): the WebSocket hub
// keeps every runner's and dashboard's socket in its memory, so every request
// goes to that one object. This Worker forwards to it, and wakes it each minute
// so its jobs (schedules, inboxes, idle computers) run while nobody is connected.
import './worker-env.js'
import { DurableObject } from 'cloudflare:workers'
import { app } from './app.js'
import { startJobs } from './jobs.js'

type Env = {
  API: DurableObjectNamespace<Api>
}

/**
 * The one Api object. An object stays in the data center it was created in, near the
 * first Worker to ask for it, and each query crosses from there to the database. This
 * Worker runs next to the database (placement in wrangler.jsonc), so a request creates it
 * in Frankfurt. The cron is not placed: should it ask first, the hint keeps the object in
 * western Europe. A new name makes a new object, created again where the Worker runs.
 */
const NAME = 'eu-central-1'

export class Api extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // An object left behind under an earlier name runs no jobs, should anything wake it.
    if ((ctx.id.name ?? NAME) === NAME) startJobs()
  }

  override fetch(request: Request) {
    return app.fetch(request)
  }

  /** Keeps the object up (src/jobs.ts runs in it). */
  ping() {
    return true
  }
}

const api = (env: Env, locationHint?: DurableObjectLocationHint) =>
  env.API.get(env.API.idFromName(NAME), locationHint && { locationHint })

export default {
  fetch(request, env) {
    return api(env).fetch(request)
  },
  async scheduled(_controller, env) {
    await api(env, 'weur').ping()
  },
} satisfies ExportedHandler<Env>
