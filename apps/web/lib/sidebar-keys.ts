// Moving through the sidebar from the keyboard (components/sidebar-keys.tsx): ⌥↑ and ⌥↓ (Alt
// elsewhere) go from conversation to conversation: they open the row above or below, in the
// order the sidebar shows them, from the + that opens the new-thread page through Pinned to
// the last thread showing under Threads. A row that folds others (a folded section, a "+N
// more") is a stop too, only focused; Enter unfolds it. The pages (Today, Inbox, Board, Lists,
// Library) are no stops: each loads a page of its own, and ⌘K reaches them. Nor are teammates
// and projects: opening one narrows the list being walked.

/** Where a stop is from the row the walk starts at. */
export type Relation = 'before' | 'same' | 'after'

/** Which way the key walks the sidebar: -1 up, 1 down; undefined when it is no such key. */
export function walkKey(e: {
  key: string
  altKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
}): -1 | 1 | undefined {
  if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return undefined
  if (e.key === 'ArrowUp') return -1
  if (e.key === 'ArrowDown') return 1
  return undefined
}

/**
 * The stop to go to, from the stops in the sidebar's order: the first after the row the walk
 * starts at going down, the last before it going up. Undefined at either end: the walk stops
 * there, without going round.
 */
export function stepTo<T>(
  stops: readonly T[],
  where: (stop: T) => Relation,
  dir: -1 | 1,
): T | undefined {
  if (dir === 1) return stops.find((s) => where(s) === 'after')
  return stops.findLast((s) => where(s) === 'before')
}

/**
 * The stop to go to from a page the walk does not reach (Library, Board…): down, the first
 * conversation, as if from the top (`isTop`, the +, which would open a new thread); up, the
 * top. Without a top (a viewer has no +), down is the first stop and up the last.
 */
export function enterAt<T>(
  stops: readonly T[],
  isTop: (stop: T) => boolean,
  dir: -1 | 1,
): T | undefined {
  if (dir === 1) return stops.find((s) => !isTop(s))
  return stops.find(isTop) ?? stops.at(-1)
}
