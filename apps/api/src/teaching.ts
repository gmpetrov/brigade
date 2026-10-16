// Teach a task: who is recording on each cloud computer. The workspace has one
// screen, so one member records at a time. A recording holds the computer for a
// lease the dashboard renews while it lasts: a closed tab lets go by itself.

/** How long a recording holds the computer without a renewal from its dashboard. */
export const LEASE_MS = 60_000

type Recording = { memberId: string; until: number }

const recordings = new Map<string, Recording>() // by computerId

/** Whoever records on this computer now, if anyone. */
export function recorder(computerId: string, now = Date.now()) {
  const held = recordings.get(computerId)
  if (held && held.until <= now) recordings.delete(computerId)
  return held && held.until > now ? held.memberId : undefined
}

/**
 * Start or renew this member's recording. Answers who records instead when
 * someone else already does, else undefined.
 */
export function holdRecording(computerId: string, memberId: string, now = Date.now()) {
  const other = recorder(computerId, now)
  if (other && other !== memberId) return other
  recordings.set(computerId, { memberId, until: now + LEASE_MS })
  return undefined
}

/** The member's recording ended: sent or discarded. */
export function endRecording(computerId: string, memberId: string) {
  if (recordings.get(computerId)?.memberId === memberId) recordings.delete(computerId)
}
