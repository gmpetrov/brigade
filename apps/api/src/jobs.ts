// The API's background work: timers that run for as long as the API does.
// Started by each entry (src/index.ts on Node, src/worker.ts on Workers), never
// while modules load: Workers allow no timers in the global scope.
import { sweepAssets } from './assets.js'
import { sweepUploads } from './attachments.js'
import { watchIdle } from './cloud.js'
import { offerRunnerUpdates, pingBrowsers, watchRunners } from './hub.js'
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
  offerRunnerUpdates()
  pingBrowsers()
  watchRunners()
  watchMail()
  watchOps()

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
  }
  setTimeout(sweep, 60_000)
  setInterval(sweep, 60 * 60_000)
}
