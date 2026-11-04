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
 * Whether the thread may glide to its end on its own now: while following, and not within
 * `quietMs` of the person's own input, which their scroll decides.
 */
export function mayFollow(following: boolean, now: number, theirsAt: number, quietMs: number) {
  return following && now - theirsAt >= quietMs
}
