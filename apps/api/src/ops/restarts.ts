// When the Api object (src/worker.ts) started, and with which version of the Worker: a start
// with the same version as the one before it is a restart no deploy explains. On 2026-10-27 the
// object went past its memory and was reset, with nothing in the logs, then again each time
// the runners reconnected (docs/workspace-hubs-plan.md, Phase 0): the cron tells operators.

/** One start of the object: when, and the Worker version it ran. */
export type Start = { at: number; version: string }

/** Starts are remembered this long. */
const KEEP_MS = 24 * 60 * 60_000
/** Restarts within this long are counted together. */
export const RESTARTS_WINDOW_MS = 15 * 60_000
/** So many restarts no deploy explains within the window are a problem. */
export const RESTARTS_ALERT = 3

/**
 * The starts with this one, and whether it is a restart no deploy explains: the version is the
 * same as the start before it. A new version restarts the object, which is expected.
 */
export function noteStart(starts: Start[], start: Start) {
  const before = starts.at(-1)
  const unexpected = !!before && before.version === start.version
  const kept = [...starts, start].filter((s) => start.at - s.at < KEEP_MS)
  return { starts: kept, unexpected }
}

/** How many of the starts within the window followed one of the same version. */
export function unexpectedRestarts(starts: Start[], now: number, windowMs = RESTARTS_WINDOW_MS) {
  let count = 0
  for (let i = 1; i < starts.length; i++)
    if (now - starts[i]!.at < windowMs && starts[i]!.version === starts[i - 1]!.version) count++
  return count
}

/** What operators are told, from the count: null while it is below the alert. */
export function restartProblem(count: number | undefined) {
  if (!count || count < RESTARTS_ALERT) return null
  return (
    `The Api object restarted ${count} times in ${RESTARTS_WINDOW_MS / 60_000} min without a new ` +
    'version of the Worker: it may be going past its memory. Every runner and dashboard ' +
    'reconnects each time, which can keep it restarting.'
  )
}
