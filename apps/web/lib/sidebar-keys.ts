// Moving through the sidebar from the keyboard (components/sidebar-keys.tsx): ⌥↑ and ⌥↓ (Alt
// elsewhere) open the row above or below, in the order the sidebar shows them, from the pages
// at its top (Today, Inbox…) through Pinned to the last thread showing under Threads. A row
// that folds others (a folded section, a "+N more") is a stop too, only focused; Enter
// unfolds it. Teammates and projects are no stops: opening one narrows the list being walked.

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
 * starts at going down, the last before it going up. With nowhere to start from (`where`
 * undefined), the first going down and the last going up. Undefined at either end: the walk
 * stops there, without going round.
 */
export function stepTo<T>(
  stops: readonly T[],
  where: ((stop: T) => Relation) | undefined,
  dir: -1 | 1,
): T | undefined {
  if (!where) return dir === 1 ? stops[0] : stops.at(-1)
  if (dir === 1) return stops.find((s) => where(s) === 'after')
  return stops.findLast((s) => where(s) === 'before')
}
