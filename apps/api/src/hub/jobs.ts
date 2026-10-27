// The hubs of this process (src/hub/memory-host.ts), watched: each half minute every hub forgets
// the runners that went silent, offers runners an update, and pings dashboards
// (WorkspaceHub.tick); each minute the process logs what its hubs hold, so growth shows before it
// costs a restart (docs/workspace-hubs-plan.md, Phase 0), and lets go of hubs with nothing open.
// On timers (watchHubs), or, in the Api object once jobs are on the queue, on the cron's minute
// ping (src/worker.ts). A hub that is a Durable Object of its own does the same on its alarm.
import { inHub } from './context.js'
import { localHubs, pruneLocalHubs } from './memory-host.js'
import { TICK_MS } from './workspace-hub.js'

/** What this process's hubs hold, summed: one line for the log. */
export function hubSizes() {
  const total = {
    hubs: 0,
    runners: 0,
    browsers: 0,
    queued: 0,
    asking: 0,
    restarting: 0,
    eventsWaiting: 0,
    terminals: 0,
  }
  for (const hub of localHubs()) {
    total.hubs++
    for (const [key, n] of Object.entries(hub.sizes())) total[key as keyof typeof total] += n
  }
  return total
}

/** Each hub of this process forgets silent runners, offers updates, pings dashboards. */
export async function tickLocalHubs() {
  await Promise.all(
    localHubs().map((hub) =>
      inHub(hub, () => hub.tick()).catch((error: unknown) =>
        console.error(`hub ${hub.workspaceId}: tick failed`, error),
      ),
    ),
  )
}

/** What this process's hubs hold, in the log; those with nothing left go. */
export function logLocalHubs() {
  const sizes = hubSizes()
  console.log(
    `hubs: ${Object.entries(sizes)
      .map(([key, n]) => `${key} ${n}`)
      .join(', ')}`,
  )
  pruneLocalHubs()
}

export function watchHubs() {
  setInterval(() => void tickLocalHubs(), TICK_MS)
  setInterval(logLocalHubs, 60_000)
}
