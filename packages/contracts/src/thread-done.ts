// A thread's done (docs/board.md): a fact someone declares, never one read from its silence.
// Its teammate declares it (complete_thread), refused while anything is still open in the
// thread; a person marks it (Mark done). A person's new message, or new work in it, reopens it.
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

/** Its operation among a teammate's schedule tools (ScheduleOperation). */
export const DoneOperations = [
  z.object({ name: z.literal(COMPLETE_THREAD_TOOL), summary: DoneSummary }),
] as const

/** POST /api/threads/:id/done: a person marks it done, with a line or none. */
export const MarkThreadDone = z.object({ summary: DoneSummary.optional() })
