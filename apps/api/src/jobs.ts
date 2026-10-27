// The API's background work (docs/workspace-hubs-plan.md, Phase 3). Each job says which
// workspaces have work due, with cheap queries, and does it for one workspace; a job that is no
// workspace's runs once for all. Every one is safe to run twice, and in any order (deployment-plan
// Phase 2): each step claims its row first.
//
// - On Node, and on Cloudflare until the JOBS queue is bound, timers run them for as long as the
//   process does (startJobs), each workspace's in turn.
// - On Cloudflare with the JOBS queue, the Worker's cron puts one message per workspace and job on
//   it each minute (dueMessages), and its consumer runs each alone (runJob, src/worker.ts): one
//   workspace's failing job is tried again, then dead-lettered, without holding back any other's.
//
// A job's message carries ids only, never what it works on: a message is at most 128 KB.
import { sweepAssets } from './assets.js'
import { sweepUploads } from './attachments.js'
import { cloudMinute, dueCloud } from './cloud.js'
import { driveReplacements, dueReplacements } from './cloud-replace.js'
import { dueHeldCalls, settleHeldCalls } from './held-calls.js'
import { processDueInbound, processInbound, sweepInbound } from './inbound.js'
import { sweepTrash } from './library-history.js'
import { dueMail, mailMinute, retryMail, sweepMail } from './mail/jobs.js'
import { processMail } from './mail/inbound.js'
import { sweep as sweepNotifications } from './notifications.js'
import { noteFailure } from './ops/failures.js'
import { advanceMerges, dueMerges } from './pull-requests.js'
import { redeliverFailed } from './routes/github-webhook.js'
import { dueCommands, giveUp, resendCommands, sweepCommands } from './runner-commands.js'
import { dueSchedules, fireDueSchedules } from './schedules.js'
import { sweepSpecParts } from './spec-parts.js'
import { dueSubscriptions, readSubscriptions } from './subscriptions/index.js'
import { sweepDoneTasks } from './tasks.js'
import { sweepDeletedThreadFiles } from './thread-delete.js'
import { sweepDeliveries } from './triggers.js'
import { sweepFileUploads } from './uploads.js'
import { dueWakeups, fireDueWakeups } from './wakeups.js'

/** One run of a job: for a workspace, for one row (an event a webhook kept), or for all (null). */
export type JobMessage = { job: string; key: string | null }

type Job = {
  /**
   * How often it runs, in seconds; none: only when asked for (enqueue), for one row. A job
   * that runs each minute or more often starts on the minute: a 07:00 schedule fires at 07:00.
   */
  every?: 30 | 60 | 600 | 3600
  /** Workspaces with work due now. Absent: the job is no workspace's, and runs once for all. */
  due?: (now: Date) => Promise<string[]>
  run: (key: string | null, now: Date) => Promise<unknown>
}

/** A workspace's, or every workspace's when run for all. */
const ws = (key: string | null) => key ?? undefined

export const JOBS = {
  // Each workspace's, each minute.
  schedules: { every: 60, due: dueSchedules, run: (key) => fireDueSchedules(ws(key)) },
  wakeups: { every: 60, due: dueWakeups, run: (key) => fireDueWakeups(ws(key)) },
  subscriptions: { every: 60, due: dueSubscriptions, run: (key) => readSubscriptions(ws(key)) },
  merges: { every: 60, due: dueMerges, run: (key) => advanceMerges(ws(key)) },
  // Its cloud computer: shut down without a plan, stopped once idle, kept alive meanwhile.
  cloud: { every: 60, due: dueCloud, run: (key) => cloudMinute(ws(key)) },
  mail: { every: 60, due: dueMail, run: (key) => retryMail(ws(key)) },
  'held-calls': {
    every: 60,
    due: (now) => dueHeldCalls(now.getTime()),
    run: (key, now) => settleHeldCalls(now.getTime(), ws(key)),
  },
  'runner-commands': {
    every: 60,
    due: dueCommands,
    run: (key, now) => resendCommands(now.getTime(), ws(key)),
  },
  'cloud-replace': { every: 60, due: dueReplacements, run: (key) => driveReplacements(ws(key)) },

  // No workspace's.
  notifications: { every: 30, run: (_key, now) => sweepNotifications(now) },
  'mail-outbound': { every: 60, run: () => mailMinute() },
  inbound: { every: 60, run: () => processDueInbound() },
  'runner-commands-given-up': { every: 60, run: (_key, now) => giveUp(now.getTime()) },
  'github-redeliver': { every: 600, run: () => redeliverFailed() },
  // Hourly: uploads abandoned mid-way or never sent with a message; files no document refers
  // to; library files in the trash long enough; tasks done long enough, off the board; images a
  // runner uploaded after their thread was deleted; finished rows of the work kept in the
  // database; mail left in its box past its time.
  'upload-sweep': { every: 3600, run: () => sweepUploads() },
  'asset-sweep': { every: 3600, run: () => sweepAssets() },
  'file-upload-sweep': { every: 3600, run: () => sweepFileUploads() },
  'trash-sweep': { every: 3600, run: () => sweepTrash() },
  'done-task-sweep': { every: 3600, run: () => sweepDoneTasks() },
  'deleted-thread-sweep': { every: 3600, run: () => sweepDeletedThreadFiles() },
  'runner-command-sweep': { every: 3600, run: () => sweepCommands() },
  'spec-part-sweep': { every: 3600, run: () => sweepSpecParts() },
  'inbound-event-sweep': { every: 3600, run: () => sweepInbound() },
  'trigger-delivery-sweep': { every: 3600, run: () => sweepDeliveries() },
  'mail-sweep': { every: 3600, run: () => sweepMail() },

  // One row each, when asked for (enqueue): a webhook's event kept, a received mail kept.
  'inbound-event': { run: (key) => (key ? processInbound(key) : Promise.resolve()) },
  'received-mail': { run: (key) => (key ? processMail(key) : Promise.resolve()) },
} satisfies Record<string, Job>

export type JobName = keyof typeof JOBS

const isJob = (name: string): name is JobName => name in JOBS

/** Run one message's job. Throws when it failed, after counting it for the ops checks. */
export async function runJob(message: JobMessage, now = new Date()) {
  if (!isJob(message.job)) {
    console.warn(`no job ${message.job}: dropped`)
    return
  }
  const job: Job = JOBS[message.job]
  try {
    await job.run(message.key, now)
  } catch (error) {
    const where = message.key ? ` (${message.key})` : ''
    console.warn(`${message.job}${where} failed: ${String(error)}`)
    noteFailure(`job:${message.job}`, error)
    throw error
  }
}

/**
 * The messages due at this minute (the cron's, on Cloudflare): each workspace's for each job due
 * now, and once each job that is no workspace's. `minute`: minutes since the epoch.
 */
export async function dueMessages(now = new Date()) {
  const minute = Math.floor(now.getTime() / 60_000)
  const messages: { body: JobMessage; delaySeconds?: number }[] = []
  for (const [name, job] of Object.entries(JOBS) as [JobName, Job][]) {
    if (!job.every) continue
    if (job.every > 60 && minute % (job.every / 60) !== 0) continue
    const keys = job.due
      ? [...new Set(await job.due(now).catch((error: unknown) => failedDue(name, error)))]
      : [null]
    for (const key of keys) {
      messages.push({ body: { job: name, key } })
      // More often than each minute: again, later in the minute.
      if (job.every === 30) messages.push({ body: { job: name, key }, delaySeconds: 30 })
    }
  }
  return messages
}

function failedDue(name: string, error: unknown): string[] {
  console.warn(`${name}: what is due could not be read: ${String(error)}`)
  noteFailure(`job:${name}`, error)
  return []
}

/** Jobs running now, in this process (Node's timers): one run of each at a time. */
const running = new Set<string>()

/** Run a job now, for each workspace with work due, or once for all. */
async function runDue(name: JobName) {
  if (running.has(name)) return
  running.add(name)
  try {
    const now = new Date()
    const job: Job = JOBS[name]
    const keys = job.due ? [...new Set(await job.due(now))] : [null]
    // Each workspace in turn: one that fails is counted, and the next goes on.
    for (const key of keys) await runJob({ job: name, key }, now).catch(() => undefined)
  } catch (error) {
    noteFailure(`job:${name}`, error)
  } finally {
    running.delete(name)
  }
}

let started = false

/**
 * Timers that run every job, for as long as the process does: on Node, and in the Api object
 * until the JOBS queue is bound. Started by each entry (src/index.ts, src/worker.ts), never while
 * modules load: Workers allow no timers in the global scope. With them, the hubs of this process
 * are watched (src/hub/jobs.ts), and the ops checks run (src/ops/checks.ts).
 */
export async function startJobs() {
  if (started) return
  started = true
  const [{ watchHubs }, { watchOps }] = await Promise.all([
    import('./hub/jobs.js'),
    import('./ops/checks.js'),
  ])
  watchHubs()
  watchOps()
  for (const [name, job] of Object.entries(JOBS) as [JobName, Job][]) {
    if (!job.every) continue
    const everyMs = job.every * 1000
    const run = () => void runDue(name)
    // On the minute (or the half), as the cron would: a 07:00 schedule fires at 07:00. Longer
    // ones a while after the start.
    const first = everyMs <= 60_000 ? everyMs - (Date.now() % everyMs) + 250 : 60_000
    setTimeout(() => {
      run()
      setInterval(run, everyMs)
    }, first)
  }
}
