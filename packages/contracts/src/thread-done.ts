// A thread's done (docs/board.md): a fact someone declares, never one read from its silence.
// Its teammate declares it (a done block at the end of its reply, which its runner sends as
// complete_thread), refused while anything is still open in the thread; a person marks it (Mark
// done). A person's new message, or new work in it, reopens it.
import { z } from 'zod'

/** The longest line a thread's done says. */
export const DONE_SUMMARY_MAX = 300

/** What was delivered, in one line: its spaces and line breaks run together. */
export const DoneSummary = z
  .string()
  .trim()
  .min(1, 'Say in a line what was delivered')
  .max(DONE_SUMMARY_MAX, `At most ${DONE_SUMMARY_MAX} characters: one line on what was delivered`)
  .transform((s) => s.replace(/\s+/g, ' '))

/** The teammate's tool, by name: the work asked in the thread is delivered. */
export const COMPLETE_THREAD_TOOL = 'complete_thread'

/**
 * The line a done block declares the thread done with (replyCard's `done`): its own, else the
 * reply's first line, as one line cut at a word to fit, so the API never refuses it for its
 * length. A teammate that wrote neither still gets its thread declared done.
 */
export function doneLine(block: string, reply: string): string {
  const first = reply
    .split('\n')
    .map((line) => line.replace(/^\s*(?:#+|[-*>•]|\d+[.)])\s*/, '').replace(/[*_`]/g, '').trim())
    .find(Boolean)
  const line = (block || first || 'Delivered').replace(/\s+/g, ' ').trim()
  if (line.length <= DONE_SUMMARY_MAX) return line
  const cut = line.slice(0, DONE_SUMMARY_MAX)
  const space = cut.lastIndexOf(' ')
  return (space > DONE_SUMMARY_MAX / 2 ? cut.slice(0, space) : cut).trim()
}

/** Its operation among a teammate's schedule tools (ScheduleOperation). */
export const DoneOperations = [
  z.object({ name: z.literal(COMPLETE_THREAD_TOOL), summary: DoneSummary }),
] as const

/** POST /api/threads/:id/done: a person marks it done, with a line or none. */
export const MarkThreadDone = z.object({ summary: DoneSummary.optional() })

/**
 * Dismiss the choices card a person sees, by its event (POST /threads/:id/choices/dismiss): a
 * later card, which they have not seen, stays open.
 */
export const DismissChoices = z.object({ seq: z.number().int().min(0) })
