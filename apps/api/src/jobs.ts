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
import { watchSubscriptions } from './subscriptions/index.js'

let started = false

export function startJobs() {
  if (started) return
  started = true
  watchSubscriptions()
  watchMerges()
  watchNotifications()
  watchSchedules()
  watchIdle()
  offerRunnerUpdates()
  pingBrowsers()
  watchRunners()

  // Uploads abandoned mid-way or never sent with a message; files no document refers to;
  // library files in the trash long enough.
  const sweep = () => {
    void sweepUploads().catch((error) => console.warn(`upload sweep failed: ${String(error)}`))
    void sweepAssets().catch((error) => console.warn(`asset sweep failed: ${String(error)}`))
    void sweepTrash().catch((error) => console.warn(`trash sweep failed: ${String(error)}`))
  }
  setTimeout(sweep, 60_000)
  setInterval(sweep, 60 * 60_000)
}
