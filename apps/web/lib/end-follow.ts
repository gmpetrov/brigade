// Following a thread's end (components/thread-conversation.tsx): what comes in glides into view,
// and the person scrolling always wins over it.

/** Keys that move the view up, away from the end. */
const UP_KEYS = new Set(['ArrowUp', 'PageUp', 'Home'])

/** Whether a person's input moves the view up, away from the thread's end: it stops following. */
export function leavesEnd(input: { type: string; deltaY?: number; key?: string }) {
  if (input.type === 'wheel') return (input.deltaY ?? 0) < 0
  if (input.type === 'keydown') return UP_KEYS.has(input.key ?? '')
  return false
}

/**
 * When the thread may glide to its end on its own: undefined once the person left it; otherwise
 * in how many ms, 0 for now. Within `quietMs` of their own input their scroll decides, and what
 * came meanwhile is followed once that is over (nothing else may come to follow it then).
 */
export function followIn(following: boolean, now: number, theirsAt: number, quietMs: number) {
  if (!following) return undefined
  return Math.max(0, theirsAt + quietMs - now)
}

/**
 * Whether the way to the end is glided rather than jumped: what came in is short (under a
 * screen away), and the thread was in already. A thread opening, or its pages coming in after
 * it opened, jumps there: gliding over all of it would scroll the whole thread before the eyes.
 */
export function glides(distance: number, viewport: number, settled: boolean) {
  return settled && distance <= viewport
}
