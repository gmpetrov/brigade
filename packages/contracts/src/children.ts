// Child threads: a teammate starts work in a thread of its own, in a fresh
// context, and its report comes back to the thread it was started from. The
// parent is woken once every child it waits for has reported (src/children.ts
// in the API). A schedule made from a thread reports there the same way.
import { z } from 'zod'

/** Children a thread may have at work at once. */
export const CHILDREN_AT_WORK = 5
/** How long a parent waits for its awaited children by default, then hears what is done. */
export const CHILD_WAIT_MINUTES = 24 * 60
/** The longest a parent may choose to wait. */
export const CHILD_WAIT_MAX_MINUTES = 7 * 24 * 60

/**
 * nothing: nothing worth telling (a schedule's run with nothing new). report: something to say.
 * needs_person: it opened a ticket and waits on a person. failed: it could not do the work.
 * cancelled: its parent stopped it (set by Brigade, not by the child).
 */
export const ChildReportStatus = z.enum([
  'nothing',
  'report',
  'needs_person',
  'failed',
  'cancelled',
])
export type ChildReportStatus = z.infer<typeof ChildReportStatus>

/** What a child said when it finished, kept on the child and shown in its parent. */
export const ChildReport = z.object({
  status: ChildReportStatus,
  summary: z.string(),
  at: z.string(),
  /** It ended its turn without calling report: its last message stands for it. */
  fromLastMessage: z.boolean().optional(),
})
export type ChildReport = z.infer<typeof ChildReport>

const Text = z.string().trim().min(1)

/** The child operations of a teammate's schedule tools, sent by the runner and checked by the API. */
export const ChildOperations = [
  z.object({
    name: z.literal('start_child'),
    title: Text.max(120),
    instructions: Text.max(20_000),
    /** A teammate's id or name; unset: the teammate calling. */
    teammate: z.string().max(200).optional(),
    /** Wait for its report with the others: woken once they all reported. */
    wait: z.boolean().default(true),
    /** Minutes to wait for it at most. */
    timeoutMinutes: z.number().int().positive().max(CHILD_WAIT_MAX_MINUTES).optional(),
  }),
  z.object({ name: z.literal('list_children') }),
  z.object({ name: z.literal('read_child'), threadId: z.string() }),
  z.object({ name: z.literal('cancel_child'), threadId: z.string() }),
  /** In a child: what it found, for its parent. Sent on when its turn ends. */
  z.object({
    name: z.literal('report'),
    status: z.enum(['nothing', 'report', 'needs_person', 'failed']),
    summary: Text.max(2_000),
  }),
] as const
