// A cloud computer marked running whose runner is away (src/cloud.ts's recoverAway, and its ops
// alert in src/ops/checks.ts): how long, from what its workspace's hub keeps (runnerAway).

/** A computer marked running whose runner stays away this long is restarted (recoverAway). */
export const RECOVER_AFTER_MS = 15 * 60_000
/** Restarts in a row without its runner coming back, at most: past them, it is left to operators. */
export const RECOVER_LIMIT = 3

/** How long a running computer's runner has been away; 0 while it is connected (null). */
export function awayFor(
  away: { since: number } | null,
  computer: { updatedAt: Date },
  now = Date.now(),
) {
  // Its status changed since (a restart, a resume): counted from then.
  return away ? Math.max(0, now - Math.max(away.since, computer.updatedAt.getTime())) : 0
}
