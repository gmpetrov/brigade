// The API on Cloudflare Workers. One Durable Object, `Api`, runs the whole API,
// as the one Node process does on a server (src/index.ts), with the WebSocket hubs
// of the workspaces whose hub is still its own; a workspace whose hubMode is
// 'object' has its hub, and its sockets, in a Durable Object of its own,
// WorkspaceHubObject (src/hub-object.ts, docs/workspace-hubs-plan.md). In
// production a small Worker routes requests and sockets (src/front.ts); this one's
// fetch sends everything to the Api object under `wrangler dev`. This one also
// wakes it each minute so its jobs (schedules, inboxes, idle computers) run while
// nobody is connected.
//
// The API itself loads only in the object, on first use: this Worker's own isolates
// then start without evaluating the whole app (281 ms at deploy, with Prisma).
import './worker-env.js'
import { DurableObject } from 'cloudflare:workers'
import { apiObject, NAME } from './api-object.js'
import { runIn } from './hub/place.js'
import type { OperationName } from './hub/operations.js'
import type { Failure } from './ops/failures.js'
import { noteStart, restartProblem, unexpectedRestarts, type Start } from './ops/restarts.js'
import { API_RESTARTING, diagnose, watchdog, type Pulse } from './ops/watchdog.js'

export { WorkspaceHubObject } from './hub-object.js'

type Env = {
  API: DurableObjectNamespace<Api>
  HUBS?: DurableObjectNamespace<import('./hub-object.js').WorkspaceHubObject>
  /** Which version of this Worker runs: a restart with the same one is no deploy's. */
  CF_VERSION_METADATA?: WorkerVersionMetadata
  // Secrets of this Worker (src/config.ts): where the watchdog's alert goes.
  OPS_ALERT_WEBHOOK_URL?: string
  OPS_ALERT_WEBHOOK_SECRET?: string
  OPS_ALERT_EMAILS?: string
  RESEND_API_KEY?: string
  MAIL_DOMAIN?: string
}

const startedAt = { at: 0 }

export class Api extends DurableObject<Env> {
  /** Its starts, from its own storage (src/ops/restarts.ts). */
  private starts: Start[] = []

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // An object left behind under an earlier name runs no jobs, should anything wake it. Its jobs
    // run as the Api object's code: the hubs they reach that are its own run here.
    if ((ctx.id.name ?? NAME) === NAME)
      void import('./jobs.js').then((jobs) => runIn({ kind: 'api' }, () => jobs.startJobs()))
    startedAt.at = Date.now()
    this.noteStart()
  }

  /** Keep this start, and say when it is a restart no deploy explains. Never stops the start. */
  private noteStart() {
    try {
      const sql = this.ctx.storage.sql
      sql.exec('CREATE TABLE IF NOT EXISTS starts (at INTEGER NOT NULL, version TEXT NOT NULL)')
      const before = sql
        .exec<{ at: number; version: string }>('SELECT at, version FROM starts ORDER BY at')
        .toArray()
      const start = { at: startedAt.at, version: this.env.CF_VERSION_METADATA?.id ?? 'unknown' }
      const { starts, unexpected } = noteStart(before, start)
      sql.exec('DELETE FROM starts')
      for (const s of starts)
        sql.exec('INSERT INTO starts (at, version) VALUES (?, ?)', s.at, s.version)
      this.starts = starts
      if (unexpected) {
        console.error(`api: restarted without a new version (${start.version})`)
        void import('./ops/failures.js').then(({ noteFailure }) =>
          noteFailure('api-reset', `restarted without a new version (${start.version})`),
        )
      }
    } catch (error) {
      console.error(`api: its start was not noted: ${String(error)}`)
    }
  }

  override async fetch(request: Request) {
    const { app } = await import('./app.js')
    return runIn({ kind: 'api' }, () => app.fetch(request))
  }

  /**
   * An operation of a workspace's hub that is this object's (hubs.get, src/hub.ts), asked by code
   * in another object. One that came here while the workspace's hub has its own object is passed
   * on there, once.
   */
  async hubCall(workspaceId: string, name: OperationName, args: unknown[], forwarded: boolean) {
    return runIn({ kind: 'api' }, async () => {
      const [{ outcomeHere }, { hubIsElsewhere, hubStub }] = await Promise.all([
        import('./hub.js'),
        import('./platform/node.js'),
      ])
      if (!forwarded && (await hubIsElsewhere(workspaceId)))
        return hubStub(workspaceId).call(workspaceId, name, args, true)
      return outcomeHere(workspaceId, name, args)
    })
  }

  /** Failures of the workspaces' hub objects, counted here, where the checks run. */
  async noteFailures(failures: Failure[]) {
    const { keepFailure } = await import('./ops/failures.js')
    for (const failure of failures) keepFailure(failure)
  }

  /** Keeps the object up (src/jobs.ts runs in it), and says whether its jobs run. */
  async ping(): Promise<Pulse> {
    const { lastChecksAt, lastCheckError } = await import('./ops/checks.js')
    return {
      upForMs: Date.now() - startedAt.at,
      checksAt: lastChecksAt,
      error: lastCheckError,
      restarts: unexpectedRestarts(this.starts, Date.now()),
    }
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
    const to = {
      webhookUrl: env.OPS_ALERT_WEBHOOK_URL,
      webhookSecret: env.OPS_ALERT_WEBHOOK_SECRET,
      emails: env.OPS_ALERT_EMAILS?.split(',')
        .map((a) => a.trim())
        .filter(Boolean),
      resendKey: env.RESEND_API_KEY,
      from: `Brigade alerts <alerts@${env.MAIL_DOMAIN || 'mails.brigade.lol'}>`,
    }
    await watchdog(to, problem).catch((error: unknown) =>
      console.error(`watchdog: ${String(error)}`),
    )
    // Restarting in a loop, it may still answer a ping between two restarts: told apart.
    const restarting = pulse instanceof Error ? null : restartProblem(pulse.restarts)
    if (restarting) console.error(`watchdog: ${restarting}`)
    await watchdog(to, restarting, Date.now(), API_RESTARTING).catch((error: unknown) =>
      console.error(`watchdog: ${String(error)}`),
    )
  },
} satisfies ExportedHandler<Env>
