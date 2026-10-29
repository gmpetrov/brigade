// A thread's child threads under it in the sidebar (components/sidebar-threads.tsx): which
// show unfolded, and which listed thread holds the one open.
import type { SidebarChild } from '@/lib/api'

export type Group = 'waiting' | 'working' | 'rest'

// Paused waits on a person too: one who took control of its computer, or usage to come back.
export const groupOf = (status: string): Group =>
  status === 'waiting' || status === 'paused'
    ? 'waiting'
    : status === 'starting' || status === 'running'
      ? 'working'
      : 'rest'

/** The thread `id` is this one, or one of its child threads. */
export const holds = (t: { id: string; children?: { id: string }[] }, id: string) =>
  t.id === id || !!t.children?.some((c) => c.id === id)

/**
 * A thread's child threads as they show unfolded: waiting on a person (a ticket for this
 * member counts), then working, then the latest; the first `cap` and the one open, or all
 * of them. `hidden`: how many the "+N more" stands for.
 */
export function subThreadRows(
  items: SidebarChild[],
  {
    needsYou,
    activeId,
    all,
    cap,
  }: { needsYou: Record<string, string>; activeId: string | null; all: boolean; cap: number },
) {
  const rank: Record<Group, number> = { waiting: 0, working: 1, rest: 2 }
  const ordered = items
    .map((c, i) => {
      const ask = needsYou[c.id] as string | undefined
      const row =
        ask && groupOf(c.status) === 'rest' ? { ...c, status: 'waiting', ask } : { ...c, ask }
      return { row, i }
    })
    .sort((a, b) => rank[groupOf(a.row.status)] - rank[groupOf(b.row.status)] || a.i - b.i)
    .map(({ row }) => row)
  const shown = all ? ordered : ordered.filter((c, i) => i < cap || c.id === activeId)
  return { shown, hidden: ordered.length - shown.length }
}
