// The timeline's marks (components/thread-timeline.tsx), from what the API gave and what is loaded.
import { groupMarks, type TimelineMessage } from '@brigade/contracts'

/**
 * The marks: those the API gave, once it answered, and a mark each for messages loaded after
 * it; else (a thread loaded from its start never asks, or the answer failed), its loaded
 * messages grouped.
 * The API's stay even once the thread looks whole: a jump to its start loads that page only,
 * and the messages between stay out of what is loaded, but not out of the timeline.
 */
export function timelineMarks(
  loaded: Omit<TimelineMessage, 'count' | 'last'>[],
  fetched: TimelineMessage[] | undefined,
): TimelineMessage[] {
  if (!fetched) return groupMarks(loaded)
  // What the answer counted: messages after it are new, a mark each.
  const through = Math.max(0, ...fetched.map((m) => m.last))
  const after = loaded.filter((m) => m.seq > through)
  return [...fetched, ...after.map((m) => ({ ...m, count: 1, last: m.seq }))]
}
