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
import { diagnose, watchdog, type Pulse } from './ops/watchdog.js'

type Env = {
  API: DurableObjectNamespace<Api>
  // Secrets of this Worker (src/config.ts): where the watchdog's alert goes.
  OPS_ALERT_WEBHOOK_URL?: string
  OPS_ALERT_WEBHOOK_SECRET?: string
  OPS_ALERT_EMAILS?: string
  RESEND_API_KEY?: string
  MAIL_DOMAIN?: string
}

const startedAt = { at: 0 }

export class Api extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // An object left behind under an earlier name runs no jobs, should anything wake it.
    if ((ctx.id.name ?? NAME) === NAME) void import('./jobs.js').then((jobs) => jobs.startJobs())
    startedAt.at = Date.now()
  }

  override async fetch(request: Request) {
    const { app } = await import('./app.js')
    return app.fetch(request)
  }

  /** Keeps the object up (src/jobs.ts runs in it), and says whether its jobs run. */
  async ping(): Promise<Pulse> {
    const { lastChecksAt, lastCheckError } = await import('./ops/checks.js')
    return { upForMs: Date.now() - startedAt.at, checksAt: lastChecksAt, error: lastCheckError }
  }
}

export default {
  fetch(request, env) {
    return apiObject(env.API).fetch(request)
  },
  async scheduled(_controller, env) {
    // A deploy resets the object: a ping that fails is tried again before it counts.
    let pulse: Pulse | Error = new Error('no answer')
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 20_000))
      pulse = await apiObject(env.API, 'weur')
        .ping()
        .catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))
      if (!(pulse instanceof Error)) break
    }
    const problem = diagnose(pulse, Date.now())
    if (problem) console.error(`watchdog: ${problem}`)
    await watchdog(
      {
        webhookUrl: env.OPS_ALERT_WEBHOOK_URL,
        webhookSecret: env.OPS_ALERT_WEBHOOK_SECRET,
        emails: env.OPS_ALERT_EMAILS?.split(',')
          .map((a) => a.trim())
          .filter(Boolean),
        resendKey: env.RESEND_API_KEY,
        from: `Brigade alerts <alerts@${env.MAIL_DOMAIN || 'mails.brigade.lol'}>`,
      },
      problem,
    ).catch((error: unknown) => console.error(`watchdog: ${String(error)}`))
  },
} satisfies ExportedHandler<Env>
