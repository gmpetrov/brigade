/** How long after a turn ended its next teammate still shows as answering next, not started yet. */
export const NEXT_FRESH_MS = 2 * 60_000

/**
 * Until when the thread says who answers next (TURN_NEXT_SOURCE): while a turn runs, for as long
 * as it runs; between turns, NEXT_FRESH_MS after the last one ended, since the next starts within
 * seconds and a list older than that was lost (a runner restart). Undefined: it no longer shows.
 */
export function nextShownUntil(working: boolean, lastTurnAt: number | undefined) {
  if (working) return Infinity
  return lastTurnAt === undefined ? undefined : lastTurnAt + NEXT_FRESH_MS
}
