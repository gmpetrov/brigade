// When an open alert's failures were last seen (`OpsAlert.lastAt`), written as each comes
// (src/ops/failures.ts, keepFailure), not only by the next check: the Api object may restart
// before that check, forgetting the failures counted in memory, and an alert's quiet time
// counts from its last failure (src/ops/checks.ts). Loaded by the first failure counted, so it
// works in a process that never ran the checks.
import { seenAt } from './alerts.js'
import { prisma } from '../db.js'
import type { Failure } from './failures.js'

/** A failure this close after the last written one of its kind is not: a burst writes once. */
export const SEEN_WRITE_MS = 60_000

/**
 * The keys of the open alerts, as the last check read them (openNow), or as read once for the
 * first failure since this process started.
 */
let openKeys: Promise<Set<string>> | null = null
/** When each kind's last-seen time was last written: at most once a minute per kind. */
const seenWritten = new Map<string, number>()

/** The open alerts' keys, as a check just read them; it adds those it raises. */
export function openNow(keys: Set<string>) {
  openKeys = Promise.resolve(keys)
}

/** Raised now: its next failure is written at once, however soon after the last. */
export function opened(kind: string) {
  seenWritten.delete(kind)
}

/**
 * A failure of an open alert's kind moves the alert's `lastAt` on, never back. The request
 * that failed never waits for it. Only for open alerts, and once a minute per kind.
 */
export async function noteSeen(failure: Failure) {
  const written = seenWritten.get(failure.kind)
  if (written !== undefined && failure.at < written + SEEN_WRITE_MS) return
  seenWritten.set(failure.kind, failure.at)
  try {
    openKeys ??= prisma.opsAlert
      .findMany({ where: { resolvedAt: null }, select: { key: true } })
      .then((rows) => new Set(rows.map((r) => r.key)))
    if (!(await openKeys).has(failure.kind)) return
    await seenAt(failure.kind, new Date(failure.at), { openOnly: true })
  } catch (error) {
    openKeys = null
    seenWritten.delete(failure.kind)
    console.error(`ops: ${failure.kind} last seen not written: ${String(error)}`)
  }
}

/** Only for tests: this module as a process that just started. */
export function forgetSeen() {
  openKeys = null
  seenWritten.clear()
}
