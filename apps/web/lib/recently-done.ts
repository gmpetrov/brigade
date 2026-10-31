// A list's recently done items (docs/lists.md): those Brigade ticked (a teammate's complete_item,
// a merged pull request, a tick from a thread's card), which alone carry when. A line a person
// ticks in the file has no date, so it stays in the list's order below.
import type { ListItemView } from '@brigade/contracts'

/** How far back "recently" goes. */
export const RECENT_DAYS = 14

export type RecentDay = { day: string; items: ListItemView[] }

/** The items ticked by Brigade in the last `RECENT_DAYS`, newest first, grouped by local day. */
export function recentlyDone(items: ListItemView[], now = new Date()): RecentDay[] {
  const since = now.getTime() - RECENT_DAYS * 86_400_000
  const recent = items
    .filter((i) => i.done && !i.missing && i.doneBy && new Date(i.doneBy.at).getTime() >= since)
    .sort((a, b) => b.doneBy!.at.localeCompare(a.doneBy!.at))
  const days: RecentDay[] = []
  for (const item of recent) {
    const day = new Date(item.doneBy!.at).toDateString()
    const last = days.at(-1)
    if (last?.day === day) last.items.push(item)
    else days.push({ day, items: [item] })
  }
  return days
}
