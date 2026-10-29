/**
 * One line of a thread, as runs of messages see it: a teammate's message (by who wrote it),
 * a step that does not end a run (thinking, a tool, nothing shown), or anything else, which does.
 */
export type RunEntry = { author: string } | 'step' | 'break'

/**
 * Where a teammate's messages in a row show its avatar once, on the first: `follows`, the
 * messages after it in the run, shown without one; `close`, those right after another message
 * of the run, with nothing between, drawn close to it.
 */
export function messageRuns(entries: RunEntry[]) {
  const follows = new Set<number>()
  const close = new Set<number>()
  let author: string | undefined
  entries.forEach((entry, at) => {
    if (entry === 'break') author = undefined
    else if (entry !== 'step') {
      if (author === entry.author) {
        follows.add(at)
        const before = entries[at - 1]
        if (before && before !== 'step' && before !== 'break') close.add(at)
      }
      author = entry.author
    }
  })
  return { follows, close }
}
