// The timeline's jumps: one page loads at a time in a thread, so a message clicked while
// another page loads waits, and only the latest one clicked goes once that load ends.

export type Jumps = {
  /** Go to `seq`: now, or once the page loading ends. Resolves once it went or gave way. */
  want: (seq: number) => Promise<void>
  /** A load ended: the message waiting, if any, goes now. */
  next: () => Promise<void>
  /** Another thread: nothing waits any more. */
  clear: () => void
}

/**
 * `busy` says whether a page loads now. `go` loads the page of a message and says whether
 * it went in; false (what was loaded changed meanwhile) tries again with what is loaded now.
 */
export function latestJump(busy: () => boolean, go: (seq: number) => Promise<boolean>): Jumps {
  let waiting: number | undefined
  let tries = 0
  const next = async () => {
    const seq = waiting
    if (seq === undefined || busy()) return
    let went: boolean
    try {
      went = await go(seq)
    } catch (e) {
      // It could not load: it stops waiting, and says so. A newer one still goes.
      if (waiting === seq) waiting = undefined
      void next().catch(() => undefined)
      throw e
    }
    // Gone, or tried enough: it stops waiting. A newer one clicked meanwhile goes now.
    if (waiting === seq && (went || ++tries >= MAX_TRIES)) {
      waiting = undefined
      tries = 0
    }
    if (waiting !== undefined) await next()
  }
  return {
    want: (seq) => {
      waiting = seq
      tries = 0
      return next()
    },
    next,
    clear: () => {
      waiting = undefined
      tries = 0
    },
  }
}

/** A message whose page keeps changing under it stops waiting after this many tries. */
const MAX_TRIES = 3
