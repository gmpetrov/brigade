// When a thread picks up again: a line with the time above a message that comes after a
// pause, as a chat does, rather than a time on every message (components/thread-view.tsx).

/** A pause this long or longer before a message puts its time above it. */
export const PAUSE_MS = 60 * 60_000

/**
 * The messages that get a time above them, by key: the first one, and each one sent an hour or
 * more after what came before it, or on another day. Only a person's (or Brigade's) messages
 * not steered into a running turn start a new exchange; the other timed items (a turn starting
 * or ending) say when the thread was last busy.
 */
export function pauses<T extends { kind: string; key: string; at?: number; steeredTo?: string }>(
  items: T[],
): Map<string, number> {
  const marks = new Map<string, number>()
  let last: number | undefined
  for (const item of items) {
    if (item.at === undefined) continue
    if (
      item.kind === 'user' &&
      !item.steeredTo &&
      (last === undefined ||
        item.at - last >= PAUSE_MS ||
        new Date(item.at).toDateString() !== new Date(last).toDateString())
    )
      marks.set(item.key, item.at)
    last = Math.max(last ?? item.at, item.at)
  }
  return marks
}

/** "16:09" today, "Yesterday 18:51", "Tue 14:30" this week, then "Sep 14, 8:33" (with the year when not this one). */
export function pauseLabel(at: number, now = Date.now()) {
  const date = new Date(at)
  const today = new Date(now)
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (date.toDateString() === today.toDateString()) return time
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`
  const weekAgo = new Date(today)
  weekAgo.setHours(0, 0, 0, 0)
  weekAgo.setDate(weekAgo.getDate() - 6)
  if (date >= weekAgo) return `${date.toLocaleDateString([], { weekday: 'short' })} ${time}`
  const day = date.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
  })
  return `${day}, ${time}`
}
