// The API on Cloudflare Workers. One Durable Object, `Api`, runs the whole API,
// as the one Node process does on a server (src/index.ts): the WebSocket hub
// keeps every runner's and dashboard's socket in its memory, so every request
// goes to that one object. This Worker forwards to it, and wakes it each minute
// so its jobs (schedules, inboxes, idle computers) run while nobody is connected.
//
// The API itself loads only in the object, on first use: the Worker in front of it
// only forwards, and a new isolate of it starts without evaluating the whole app
// (281 ms at deploy, with Prisma).
import './worker-env.js'
import { DurableObject } from 'cloudflare:workers'

type Env = {
  API: DurableObjectNamespace<Api>
}

/**
 * The one Api object. An object stays in the data center it was created in, near the
 * first Worker to ask for it, and each query crosses from there to the database. This
 * one was created in Frankfurt, next to the database, by this Worker while it was placed
 * there (`"placement": { "region": "aws:eu-central-1" }` in wrangler.jsonc). The
 * placement is gone since: it made each WebSocket's opening about half a second slower.
 * A new name makes a new object, near whichever Worker asks first: to have it next to
 * the database again, place the Worker there until the object is created. The cron is
 * never placed: should it ask first, the hint keeps the object in western Europe.
 */
const NAME = 'eu-central-1'

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
