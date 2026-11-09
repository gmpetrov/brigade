// A long thread opens on its last messages only: drawing all it has loaded (up to 30 messages and
// their work, its widgets and cards) made opening it slow, the click doing nothing meanwhile, when
// only its end is in sight. What is above shows as the person reads up to it
// (components/thread-conversation.tsx), going to a message shows it all (revealSeq, the timeline).

/** What it needs of a thread's items (components/thread-view.tsx's Item). */
type Entry = { kind: string; seq?: number; side?: unknown; steeredTo?: string }

/** Messages a thread opens on, and how many more each read up shows. */
export const OPEN_MESSAGES = 5
export const MORE_MESSAGES = 10

/**
 * A person's message that starts a turn: where the thread can begin, nothing of the turn
 * before it below it (ThreadItems lays each out from there). Not one answered on the side or
 * given to a running turn, which belong to the turn they were written during.
 */
const starts = (item: Entry): item is Entry & { seq: number } =>
  item.kind === 'user' && !item.side && !item.steeredTo && item.seq !== undefined

/**
 * Where to show the thread from, as the seq of a person's message: the `count`-th such message
 * before `before` (a seq; the end when unset). Null when there are no more than that: all of it.
 */
export function windowStart(items: Entry[], count: number, before?: number): number | null {
  let seen = 0
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (!starts(item) || (before !== undefined && item.seq >= before)) continue
    seen++
    if (seen === count) {
      // Nothing worth holding back above it: all of it.
      return items.slice(0, i).some(starts) ? item.seq : null
    }
  }
  return null
}
