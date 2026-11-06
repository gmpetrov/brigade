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

/**
 * Where a row goes: by its status, but a failed one that asks something of the member (it waits
 * on them, src/failed.ts in the API, or a ticket in it does) goes with those waiting, its dot
 * still red.
 */
export const groupWith = (status: string, ask: string | undefined): Group =>
  status === 'failed' && ask ? 'waiting' : groupOf(status)

type Tree = { id: string; children?: Tree[] }

/**
 * The thread `id` is this one, or one of its child threads, at any depth: a list's row holds
 * its threads and their own child threads.
 */
export const holds = (t: Tree, id: string): boolean =>
  t.id === id || !!t.children?.some((c) => holds(c, id))

/**
 * A thread's child threads as they show unfolded: waiting on a person (a ticket for this
 * member counts, and a failed one waiting on them, still red), then working, then the latest;
 * the first `cap` and the one open (or the one holding it), or all of them. `hidden`: how many
 * the "+N more" stands for.
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
        ask && groupOf(c.status) === 'rest' && c.status !== 'failed'
          ? { ...c, status: 'waiting', ask }
          : { ...c, ask }
      return { row, i }
    })
    .sort(
      (a, b) =>
        rank[groupWith(a.row.status, a.row.ask)] - rank[groupWith(b.row.status, b.row.ask)] ||
        a.i - b.i,
    )
    .map(({ row }) => row)
  const shown = all
    ? ordered
    : ordered.filter((c, i) => i < cap || (!!activeId && holds(c, activeId)))
  return { shown, hidden: ordered.length - shown.length }
}

/**
 * The thread without its child threads that review a pull request, at any depth: they show
 * in it (its pull request card opens them), not in the sidebar. Unless one needs the member
 * (a ticket, a failed review waiting on them), or is the thread open, so the sidebar still
 * shows where they are.
 */
export function withoutReviews<T extends { children?: SidebarChild[] }>(
  t: T,
  needsYou: Record<string, string>,
  openId: string | null,
): T {
  if (!t.children) return t
  const children = t.children
    .filter((c) => !c.review || !!needsYou[c.id] || c.id === openId)
    .map((c) => withoutReviews(c, needsYou, openId))
  return { ...t, children }
}
