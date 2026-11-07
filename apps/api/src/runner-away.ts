// A cloud computer marked running whose runner is away (src/cloud.ts's recoverAway, and its ops
// alert in src/ops/checks.ts): how long, from what its workspace's hub keeps (runnerAway), and
// what Brigade does about it (recoveryStep).
import type { RecoverAnswer } from '@brigade/providers'

/**
 * A cloud computer's runner away while its computer is marked running (the hub's runnerAway):
 * since when, what boat answered when asked to recover it during this absence, and how many
 * times Brigade stopped it with its last snapshot and started it again (recoverAway).
 */
export type RunnerAway = {
  since: number
  restarts: number
  gaveUp?: boolean
  /** When boat was last asked to recover it, and what it answered. */
  recoverAskedAt?: number
  recover?: RecoverAnswer
}

/** Its runner away this long, Brigade looks at whether boat still reaches the machine. */
export const RECOVER_AFTER_MS = 20 * 60_000
/**
 * boat saves a running machine's disk, or checks it has nothing new to save, at least every 10
 * minutes or so (Nov 5–7): nothing saved for this long, it no longer reaches the machine. Its own
 * rule refuses a stop past 30 minutes without a snapshot.
 */
export const UNSAVED_MS = 15 * 60_000
/** A power-cycle boat accepted: its runner is waited for this long (boat says 1–2 minutes). */
export const RECOVER_WAIT_MS = 5 * 60_000
/** boat answered it reaches the machine: asked again this long after, should that change. */
export const RECOVER_AGAIN_MS = 10 * 60_000
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

/** What Brigade does now for a computer marked running whose runner is away (recoverAway). */
export type RecoveryStep = 'none' | 'recover' | 'replace' | 'give-up'

/**
 * From how long its runner has been away (`awayMs`), when boat last saved its disk or checked it
 * had nothing new to save (`savedAt`), its last completed snapshot (`snapshotAt`, what a forced
 * stop keeps) and whether its runner said its disk is full:
 * - its runner away less than RECOVER_AFTER_MS, or boat saving it lately: nothing. A machine boat
 *   still saves answers; on Nov 7 at 11:05, one stalled for 12 minutes after a resume and came
 *   back by itself, and starting it again then would only start its restore over;
 * - else boat is asked to recover it (power-cycle its machine, its disk untouched);
 * - boat cannot (`impossible`: its baremetal machines), or its runner is still away
 *   RECOVER_WAIT_MS after a power-cycle: it is stopped with its last snapshot and started again;
 * - boat reaches the machine though it does not save it (a full disk, say): left to operators.
 * Never stopped so without a snapshot (it would lose the whole disk), nor while its disk is full
 * (what is not saved may be what fills it, and boat does not start one past ~90% again).
 */
export function recoveryStep(
  away: RunnerAway,
  state: {
    awayMs: number
    savedAt: number | null
    snapshotAt: number | null
    diskFull: boolean
    now: number
  },
): RecoveryStep {
  const { awayMs, savedAt, snapshotAt, diskFull, now } = state
  if (awayMs < RECOVER_AFTER_MS || away.gaveUp) return 'none'
  if (savedAt !== null && now - savedAt < UNSAVED_MS) return 'none'
  const askedFor = now - (away.recoverAskedAt ?? 0)
  if (!away.recover) return 'recover'
  if (away.recover === 'reachable') return askedFor >= RECOVER_AGAIN_MS ? 'recover' : 'none'
  if (away.recover === 'recovering' && askedFor < RECOVER_WAIT_MS) return 'none'
  if (snapshotAt === null || diskFull) return 'none'
  return away.restarts >= RECOVER_LIMIT ? 'give-up' : 'replace'
}
