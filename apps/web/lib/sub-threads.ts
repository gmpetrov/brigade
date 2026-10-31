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

type Tree = { id: string; children?: Tree[] }

/**
 * The thread `id` is this one, or one of its child threads, at any depth: a list's row holds
 * its threads and their own child threads.
 */
export const holds = (t: Tree, id: string): boolean =>
  t.id === id || !!t.children?.some((c) => holds(c, id))

/**
 * A thread's child threads as they show unfolded: waiting on a person (a ticket for this
 * member counts), then working, then the latest; the first `cap` and the one open (or the
 * one holding it), or all of them. `hidden`: how many the "+N more" stands for.
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
  const shown = all
    ? ordered
    : ordered.filter((c, i) => i < cap || (!!activeId && holds(c, activeId)))
  return { shown, hidden: ordered.length - shown.length }
}
