// A resumed cloud computer can run before its disk is all there (RestoreState): waiting for it.
import type { RestoreState } from '@brigade/providers'

export type RestoreWait = {
  /** Between checks. */
  everyMs: number
  /** At most this long, from the first check. */
  forMs: number
  /** Checks failing in a row before the last one's error is thrown: one blip is not the end. */
  failures: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export type Restored = { done: true; at: string } | { done: false; why: 'stopped' | 'too long' }

/** Once the computer's restore is done: which one it was, or why it never will be. */
export async function restored(
  check: () => Promise<RestoreState>,
  wait: RestoreWait,
): Promise<Restored> {
  const sleep = wait.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = wait.now ?? Date.now
  const since = now()
  let failed = 0
  for (;;) {
    let state: RestoreState | null = null
    try {
      state = await check()
      failed = 0
    } catch (error) {
      if (++failed >= wait.failures) throw error
    }
    if (state?.done) return { done: true, at: state.at }
    if (state && !state.running) return { done: false, why: 'stopped' }
    if (now() - since >= wait.forMs) return { done: false, why: 'too long' }
    await sleep(wait.everyMs)
  }
}
