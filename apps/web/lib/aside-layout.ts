// Where the running turn's asides show (docs/side-replies.md): one card at the turn's end.

/** A turn's asides, as the thread lays them out (thread-view.tsx's layoutThread). */
export type AsidesNode = { type: 'asides'; is: number[]; live: boolean; quiet?: boolean }

/**
 * The running turn's asides (those after `from`, where it began) in one card at the end of what
 * it shows, above its Working line: what it writes meanwhile goes above the card, which stays by
 * the composer, rather than a new card each time it wrote between two of them. `quiet` once it
 * wrote after the last of them: the card may fold to a line then (AsideGroup).
 */
export function runningAsides<N extends { type: string }>(
  nodes: (N | AsidesNode)[],
  items: { kind: string }[],
  from: number,
): (N | AsidesNode)[] {
  const mine: AsidesNode[] = []
  const isMine = (node: { type: string }): node is AsidesNode =>
    node.type === 'asides' && (node as AsidesNode).is[0]! > from
  // A message steered into the turn folds what came before it ("Worked for"): its asides
  // still join the card rather than hide in that fold.
  const take = <M extends { type: string }>(list: M[]): M[] =>
    list.flatMap((node) => {
      if (isMine(node)) {
        mine.push(node)
        return []
      }
      const inner = (node as { inner?: M[] }).inner
      if (node.type === 'worked' && inner) return [{ ...node, inner: take(inner) }]
      return [node]
    })
  const rest = take(nodes)
  if (mine.length === 0) return nodes
  const is = mine.flatMap((node) => node.is).sort((a, b) => a - b)
  const quiet = items.slice(is.at(-1)! + 1).some((item) => item.kind === 'assistant')
  return [...rest, { type: 'asides', is, live: true, quiet }]
}
