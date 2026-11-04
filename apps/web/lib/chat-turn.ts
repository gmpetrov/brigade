/**
 * A turn a person wrote into while it ran (their messages steered in, as in a chat), as the thread
 * lays it out (thread-view.tsx's layoutThread): their messages and what answers them in order, the
 * turn's steps together under one line (its Working line, then one "Worked for"), not cut into
 * pieces at each message.
 */

/** What an item of a turn is here: a message steered in, the teammate's text, a step, or else. */
export type ChatEntry = 'steered' | 'message' | 'step' | 'other'

/**
 * The teammate's messages that answer one steered in: right after it, before the turn's next
 * step (a question it could answer at once). They stay in sight once the turn ends, beside its
 * answer, rather than fold away with its steps.
 */
export function quickReplies(entries: ChatEntry[]): Set<number> {
  const quick = new Set<number>()
  let afterSteer = false
  entries.forEach((entry, at) => {
    if (entry === 'steered') afterSteer = true
    else if (entry === 'step') afterSteer = false
    else if (entry === 'message' && afterSteer) quick.add(at)
  })
  return quick
}

/**
 * Whether the turn answered since its last step, a quick reply aside (one that only waited on
 * its background work, say): a message steered in then starts afresh, and what came before
 * stands as the answer to the message before it.
 */
export function answeredSinceStep(entries: ChatEntry[]): boolean {
  const quick = quickReplies(entries)
  const last = entries.lastIndexOf('step')
  if (last < 0) return false
  return entries.some((entry, at) => at > last && entry === 'message' && !quick.has(at))
}
