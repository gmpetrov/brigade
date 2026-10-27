// The API's background work: timers that run for as long as the API does.
// Started by each entry (src/index.ts on Node, src/worker.ts on Workers), never
// while modules load: Workers allow no timers in the global scope.
import { sweepAssets } from './assets.js'
import { sweepUploads } from './attachments.js'
import { watchIdle } from './cloud.js'
import { driveReplacements } from './cloud-replace.js'
import { watchHubs } from './hub/jobs.js'
import { settleHeldCalls } from './held-calls.js'
import { processDueInbound, sweepInbound } from './inbound.js'
import { resendCommands, sweepCommands } from './runner-commands.js'
import { sweepSpecParts } from './spec-parts.js'
import { redeliverFailed } from './routes/github-webhook.js'
import { sweepDeliveries } from './triggers.js'
import { sweepTrash } from './library-history.js'
import { watchNotifications } from './notifications.js'
import { watchMerges } from './pull-requests.js'
import { watchSchedules } from './schedules.js'
import { sweepDoneTasks } from './tasks.js'
import { sweepDeletedThreadFiles } from './thread-delete.js'
import { watchSubscriptions } from './subscriptions/index.js'
import { watchWakeups } from './wakeups.js'
import { watchMail } from './mail/jobs.js'
import { noteFailure } from './ops/failures.js'
import { watchOps } from './ops/checks.js'
import { sweepFileUploads } from './uploads.js'

let started = false

export function startJobs() {
  if (started) return
  started = true
  watchSubscriptions()
  watchMerges()
  watchNotifications()
  watchSchedules()
  watchWakeups()
  watchIdle()
  watchHubs()
  watchMail()
  watchOps()

  // Work kept as rows, not in memory (docs/deployment-plan.md, Phase 2): each minute, decided
  // calls a restart cut off are made, commands runners did not acknowledge go again, webhooks
  // are processed; each ten minutes, GitHub's failed deliveries are asked for again.
  const durable = (name: string, work: () => Promise<unknown>) => () =>
    void work().catch((error) => {
      console.warn(`${name} failed: ${String(error)}`)
      noteFailure(`job:${name}`, error)
    })
  const minute = [
    durable('held-calls', () => settleHeldCalls()),
    durable('runner-commands', () => resendCommands()),
    durable('inbound', () => processDueInbound()),
    // Cloud computers being moved onto a new VM go on where an API restart left them.
    durable('cloud-replace', () => driveReplacements()),
  ]
  setTimeout(() => minute.forEach((run) => run()), 20_000)
  setInterval(() => minute.forEach((run) => run()), 60_000)
  const redeliver = durable('github-redeliver', () => redeliverFailed())
  setTimeout(redeliver, 2 * 60_000)
  setInterval(redeliver, 10 * 60_000)

  // Uploads abandoned mid-way or never sent with a message; files no document refers to;
  // library files in the trash long enough; tasks done long enough, off the board; images
  // a runner uploaded after their thread was deleted.
  const sweep = () => {
    const failed = (name: string) => (error: unknown) => {
      console.warn(`${name} sweep failed: ${String(error)}`)
      noteFailure(`job:${name.replaceAll(' ', '-')}-sweep`, error)
    }
    void sweepUploads().catch(failed('upload'))
    void sweepAssets().catch(failed('asset'))
    void sweepFileUploads().catch(failed('file upload'))
    void sweepTrash().catch(failed('trash'))
    void sweepDoneTasks().catch(failed('done task'))
    void sweepDeletedThreadFiles().catch(failed('deleted thread'))
    // Finished rows of the work kept in the database (held calls go in their own tick).
    void sweepCommands().catch(failed('runner command'))
    void sweepSpecParts().catch(failed('spec part'))
    void sweepInbound().catch(failed('inbound event'))
    void sweepDeliveries().catch(failed('trigger delivery'))
  }
  setTimeout(sweep, 60_000)
  setInterval(sweep, 60 * 60_000)
}
