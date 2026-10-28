// The timeline's jumps: one page loads at a time in a thread, so a message clicked while
// another page loads waits, and only the latest one clicked goes once that load ends.

export type Jumps = {
  /**
   * Go to `seq`: now, or once the page loading ends. Resolves once it went or gave way to
   * a newer click; rejects when its own page could not load.
   */
  want: (seq: number) => Promise<void>
  /** A load ended: the message waiting, if any, goes now. */
  next: () => Promise<void>
  /** Another thread: nothing waits any more. */
  clear: () => void
}

type Waiting = { seq: number; tries: number; done: () => void; failed: (e: unknown) => void }

/**
 * `busy` says whether a page loads now. `go` loads the page of a message and says whether
 * it went in; false (what was loaded changed meanwhile) tries again with what is loaded now.
 */
export function latestJump(busy: () => boolean, go: (seq: number) => Promise<boolean>): Jumps {
  let waiting: Waiting | undefined
  const settle = (w: Waiting, error?: { e: unknown }) => {
    if (waiting === w) waiting = undefined
    if (error) w.failed(error.e)
    else w.done()
  }
  const next = async () => {
    const w = waiting
    if (!w || busy()) return
    let went: boolean
    try {
      went = await go(w.seq)
    } catch (e) {
      // Given way to a newer click meanwhile, its failure is not said: the newer one goes.
      if (waiting === w) settle(w, { e })
      return next()
    }
    if (waiting === w && (went || ++w.tries >= MAX_TRIES)) settle(w)
    return next()
  }
  return {
    want: (seq) =>
      new Promise<void>((done, failed) => {
        // The one waiting gives way: it went nowhere, and says nothing went wrong.
        if (waiting) waiting.done()
        waiting = { seq, tries: 0, done, failed }
        void next()
      }),
    next,
    clear: () => {
      waiting?.done()
      waiting = undefined
    },
  }
}

/** A message whose page keeps changing under it stops waiting after this many tries. */
const MAX_TRIES = 3
