/**
 * What the turn about to start waits for now: a free slot on its computer, or its thread's
 * files to be ready there (the thread's last slot or preparing item), unless a turn started,
 * ended or failed after it. A preparing item also ends with a note after it (its files could
 * not be put back). Whatever came before it counts for nothing, such as a resumed turn's
 * earlier output or another teammate's reply.
 */
export function turnWait<T extends { kind: string }>(items: T[]) {
  const i = items.findLastIndex((it) => it.kind === 'slot' || it.kind === 'preparing')
  if (i < 0) return undefined
  const item = items[i]!
  const ends = ['start', 'turn', 'error', ...(item.kind === 'preparing' ? ['note'] : [])]
  const ended = items.slice(i + 1).some((it) => ends.includes(it.kind))
  return ended ? undefined : (item as Extract<T, { kind: 'slot' | 'preparing' }>)
}
