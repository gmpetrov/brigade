/**
 * The turn that waits for a free slot on its computer now: the thread's last slot item,
 * unless a turn started, ended or failed after it. Whatever came before it counts for
 * nothing, such as a resumed turn's earlier output or another teammate's reply.
 */
export function slotWait<T extends { kind: string }>(items: T[]) {
  const i = items.findLastIndex((it) => it.kind === 'slot')
  if (i < 0) return undefined
  const ended = items.slice(i + 1).some((it) => ['start', 'turn', 'error'].includes(it.kind))
  return ended ? undefined : (items[i] as Extract<T, { kind: 'slot' }>)
}
