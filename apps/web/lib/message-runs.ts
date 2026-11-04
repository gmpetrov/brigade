/**
 * One line of a thread, as runs of messages see it: a teammate's message (by who wrote it),
 * a step that does not end a run (thinking, a tool, nothing shown), or anything else, which does.
 */
export type RunEntry = { author: string } | 'step' | 'break'

/**
 * A teammate's messages in a row, as the thread shows them (what a fold hides is not among the
 * entries): `starts`, the first of each run, which names its author when several teammates are
 * in the thread; `follows`, the messages after it in the run; `close`, those right after another
 * message of the run, with nothing between, drawn close to it.
 */
export function messageRuns(entries: RunEntry[]) {
  const starts = new Set<number>()
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
      } else starts.add(at)
      author = entry.author
    }
  })
  return { starts, follows, close }
}
