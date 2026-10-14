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

export class Api extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    startJobs()
  }

  override fetch(request: Request) {
    return app.fetch(request)
  }

  /** Keeps the object up (src/jobs.ts runs in it). */
  ping() {
    return true
  }
}

/** The one Api object, created next to the database (Neon, eu-central-1). */
const api = (env: Env) => env.API.get(env.API.idFromName('main'), { locationHint: 'weur' })

export default {
  fetch(request, env) {
    return api(env).fetch(request)
  },
  async scheduled(_controller, env) {
    await api(env).ping()
  },
} satisfies ExportedHandler<Env>
