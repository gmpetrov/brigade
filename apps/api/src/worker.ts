// The API on Cloudflare Workers. One Durable Object, `Api`, runs the whole API,
// as the one Node process does on a server (src/index.ts), with the WebSocket hubs
// of the workspaces whose hub is still its own; a workspace whose hubMode is
// 'object' has its hub, and its sockets, in a Durable Object of its own,
// WorkspaceHubObject (src/hub-object.ts, docs/workspace-hubs-plan.md). In
// production a small Worker routes requests and sockets (src/front.ts); this one's
// fetch sends everything to the Api object under `wrangler dev`. Each minute its
// cron wakes the Api object, and, once the JOBS queue is bound, puts the jobs due on
// it, which its consumer runs apart (src/jobs.ts); until then the Api object runs
// them on its own timers.
//
// The API itself loads only in the object, on first use: this Worker's own isolates
// then start without evaluating the whole app (281 ms at deploy, with Prisma).
import './worker-env.js'
import { DurableObject } from 'cloudflare:workers'
import { apiObject, NAME } from './api-object.js'
import { runIn } from './hub/place.js'
import { STATELESS_HEADER } from './hub/route.js'
import type { OperationName } from './hub/operations.js'
import type { JobMessage } from './jobs.js'
import type { ThreadWaiting } from './hub/host.js'
import type { Failure } from './ops/failures.js'
import {
  IDLE_MS,
  noteStart,
  restartProblem,
  unexpectedRestarts,
  type Start,
} from './ops/restarts.js'
import { API_RESTARTING, diagnose, watchdog, type Pulse } from './ops/watchdog.js'

export { WorkspaceHubObject } from './hub-object.js'

type Env = {
  API: DurableObjectNamespace<Api>
  HUBS?: DurableObjectNamespace<import('./hub-object.js').WorkspaceHubObject>
  /** The jobs' queue (src/jobs.ts): used once JOBS_ON_QUEUE is '1'; until then timers run them. */
  JOBS?: Queue<JobMessage>
  JOBS_ON_QUEUE?: string
  /** Hyperdrive, cache off: the cron and the consumer connect each time (src/hub-object.ts). */
  DB_HYPERDRIVE?: Hyperdrive
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

/** Whether the jobs go through their queue (wrangler.jsonc), or the Api object's timers. */
const onQueue = (env: Env) => Boolean(env.JOBS) && env.JOBS_ON_QUEUE === '1'

export class Api extends DurableObject<Env> {
  /** Its starts, from its own storage (src/ops/restarts.ts). */
  private starts: Start[] = []
  /** When it last noted it was busy, in its storage: a start long after it was idle. */
  private activeNotedAt = 0

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // An object left behind under an earlier name runs no jobs, should anything wake it. Its jobs
    // run as the Api object's code: the hubs they reach that are its own run here. With the jobs'
    // queue, it runs none: the cron and the queue's consumer do (src/jobs.ts).
    if ((ctx.id.name ?? NAME) === NAME && !onQueue(env))
      void import('./jobs.js').then((jobs) => runIn({ kind: 'api' }, () => jobs.startJobs()))
    startedAt.at = Date.now()
    this.noteStart()
  }

  /** Keep this start, and say when it is a restart no deploy explains. Never stops the start. */
  private noteStart() {
    try {
      const sql = this.ctx.storage.sql
      sql.exec('CREATE TABLE IF NOT EXISTS starts (at INTEGER NOT NULL, version TEXT NOT NULL)')
      // Added after the table: an object made before has none.
      const columns = sql.exec<{ name: string }>('PRAGMA table_info(starts)').toArray()
      if (!columns.some((c) => c.name === 'idle'))
        sql.exec('ALTER TABLE starts ADD COLUMN idle INTEGER NOT NULL DEFAULT 0')
      const before = sql
        .exec<{ at: number; version: string; idle: number }>(
          'SELECT at, version, idle FROM starts ORDER BY at',
        )
        .toArray()
        .map((s) => ({ at: s.at, version: s.version, idle: s.idle === 1 }))
      const activeAt = this.ctx.storage.kv.get<number>('activeAt') ?? 0
      const start = {
        at: startedAt.at,
        version: this.env.CF_VERSION_METADATA?.id ?? 'unknown',
        idle: startedAt.at - activeAt >= IDLE_MS,
      }
      const { starts, unexpected } = noteStart(before, start)
      sql.exec('DELETE FROM starts')
      for (const s of starts)
        sql.exec(
          'INSERT INTO starts (at, version, idle) VALUES (?, ?, ?)',
          s.at,
          s.version,
          s.idle ? 1 : 0,
        )
      this.noteActive()
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

  /** Busy now, as kept in its storage: at most every few seconds, a write each. */
  private noteActive() {
    const now = Date.now()
    if (now - this.activeNotedAt < 5_000) return
    this.activeNotedAt = now
    try {
      this.ctx.storage.kv.put('activeAt', now)
    } catch (error) {
      console.error(`api: activity not noted: ${String(error)}`)
    }
  }

  override async fetch(request: Request) {
    this.noteActive()
    const { app } = await import('./app.js')
    return runIn({ kind: 'api' }, () => app.fetch(request))
  }

  /**
   * An operation of a workspace's hub that is this object's (hubs.get, src/hub.ts), asked by code
   * in another object. One that came here while the workspace's hub has its own object is passed
   * on there, once.
   */
  async hubCall(workspaceId: string, name: OperationName, args: unknown[], forwarded: boolean) {
    this.noteActive()
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
    this.noteActive()
    const { keepFailure } = await import('./ops/failures.js')
    for (const failure of failures) keepFailure(failure)
  }

  /** A hub object's threads whose events wait, for the checks (src/ops/checks.ts). */
  async noteThreadsWaiting(workspaceId: string, waiting: ThreadWaiting[]) {
    this.noteActive()
    const { noteReportedWaiting } = await import('./ops/checks.js')
    noteReportedWaiting(workspaceId, waiting)
  }

  /**
   * The cron's minute: keeps the object up, and says whether its checks run. With the jobs on
   * the queue, the object has no timers: this minute also runs the ops checks, and watches its
   * own hubs (src/hub/jobs.ts).
   */
  async ping(): Promise<Pulse> {
    this.noteActive()
    const { lastChecksAt, lastCheckError, runChecks } = await import('./ops/checks.js')
    if (onQueue(this.env) && (this.ctx.id.name ?? NAME) === NAME) {
      const { logLocalHubs, tickLocalHubs } = await import('./hub/jobs.js')
      this.ctx.waitUntil(
        runIn({ kind: 'api' }, async () => {
          await tickLocalHubs()
          logLocalHubs()
          await runChecks()
        }).catch((error: unknown) => console.error(`api: the minute's work failed`, error)),
      )
    }
    return {
      upForMs: Date.now() - startedAt.at,
      checksAt: lastChecksAt,
      error: lastCheckError,
      restarts: unexpectedRestarts(this.starts, Date.now()),
    }
  }
}

/**
 * Code of this Worker's own isolates (the cron, the queue's consumer, the reads the front sends
 * here), not of an object: a client of its own for each run, as connections cannot outlive it,
 * and its failures counted in the Api object, where the checks run.
 */
async function stateless<T>(env: Env, ctx: ExecutionContext, fn: () => Promise<T>) {
  const [{ newPrismaClient, withPrismaClient }, { withFailureSink }] = await Promise.all([
    import('./db.js'),
    import('./ops/failures.js'),
  ])
  const client = newPrismaClient(env.DB_HYPERDRIVE?.connectionString ?? process.env.DATABASE_URL!, {
    max: 3,
    idleTimeoutMillis: 1_000,
  })
  const failures: Failure[] = []
  try {
    return await withPrismaClient(client, () =>
      withFailureSink((failure) => failures.push(failure), fn),
    )
  } finally {
    ctx.waitUntil(
      Promise.all([
        client.$disconnect().catch(() => undefined),
        failures.length
          ? apiObject(env.API)
              .noteFailures(failures)
              .catch((error: unknown) => console.error(`failures not counted: ${String(error)}`))
          : undefined,
      ]),
    )
  }
}

/** A queue's batch takes at most this many messages at once; more wait for the next batch. */
const SEND_BATCH = 100

export default {
  /**
   * A request the front sends here runs in this isolate, with a client of its own (Phase 4 of
   * docs/workspace-hubs-plan.md): a read under STATELESS_ROUTES. Everything else goes to the Api
   * object, as under `wrangler dev` without the front.
   */
  async fetch(request, env, ctx) {
    if (request.headers.get(STATELESS_HEADER) !== '1') return apiObject(env.API).fetch(request)
    const { app } = await import('./app.js')
    const response = await stateless(env, ctx, async () => app.fetch(request))
    // Where it ran, to compare its times with the Api object's (Server-Timing).
    const answer = new Response(response.body, response)
    answer.headers.set('x-brigade-ran', 'isolate')
    return answer
  },

  /**
   * The jobs' queue (src/jobs.ts): each message one job for one workspace, or for all. One that
   * fails is tried again later, a few times, then dead-lettered (wrangler.jsonc).
   */
  async queue(batch, env, ctx) {
    await stateless(env, ctx, async () => {
      const { runJob } = await import('./jobs.js')
      for (const message of batch.messages)
        try {
          await runJob(message.body)
          message.ack()
        } catch {
          message.retry({
            delaySeconds: Math.min(600, 30 * 2 ** Math.max(0, message.attempts - 1)),
          })
        }
    })
  },

  async scheduled(controller, env, ctx) {
    // The jobs due this minute, each workspace's apart, on the queue.
    if (onQueue(env) && env.JOBS) {
      const jobs = env.JOBS
      ctx.waitUntil(
        stateless(env, ctx, async () => {
          const { dueMessages } = await import('./jobs.js')
          const messages = await dueMessages(new Date(controller.scheduledTime))
          for (let i = 0; i < messages.length; i += SEND_BATCH)
            await jobs.sendBatch(messages.slice(i, i + SEND_BATCH))
        }).catch((error: unknown) => console.error(`jobs not queued: ${String(error)}`)),
      )
    }
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
} satisfies ExportedHandler<Env, JobMessage>
