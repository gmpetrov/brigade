// Going to a message the thread folds away (a turn's Aside, once the turn ended): a reply's
// quote or the timeline scrolls to where it is folded, and asks the fold to open (revealSeq).

const EVENT = 'brigade:reveal-seq'

/** Opens what folds the message with this seq away, if anything does. */
export function revealSeq(seq: number) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<number>(EVENT, { detail: seq }))
}

/** Calls `listener` with each seq something goes to; returns how to stop. */
export function onRevealSeq(listener: (seq: number) => void) {
  const handle = (event: Event) => listener((event as CustomEvent<number>).detail)
  window.addEventListener(EVENT, handle)
  return () => window.removeEventListener(EVENT, handle)
}
