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
/** Threads that may follow one thread (follow_thread). */
export const FOLLOWERS_PER_THREAD = 20

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
  /**
   * Be woken by another thread's report, like its parent: a child of another run of the same
   * playbook (e.g. the fix of a bug several customers reported).
   */
  z.object({ name: z.literal('follow_thread'), threadId: z.string().trim().min(1) }),
  /** In a child: what it found, for its parent. Sent on when its turn ends. */
  z.object({
    name: z.literal('report'),
    status: z.enum(['nothing', 'report', 'needs_person', 'failed']),
    summary: Text.max(2_000),
  }),
] as const

/** In a child's first message, after its parent's teammate: what says it is one (childNote). */
const CHILD_TASK_MARK = 'started this thread from the thread'

/** Text cut to `max` characters, with an ellipsis when it was longer. */
export const clipReport = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text

/** One line of a report, for a note: no line breaks, kept short. */
const line = (text: string) => clipReport(text.replace(/\s+/g, ' ').trim(), 400)

const STATUS_WORDS: Record<ChildReportStatus, string> = {
  nothing: 'nothing new',
  report: 'reports',
  needs_person: 'needs a person (a ticket is open in it)',
  failed: 'failed',
  cancelled: 'cancelled',
}

/** What the child is told with its work: where it comes from and how to finish. */
export function childPrompt(input: { from: string; parentTitle: string; instructions: string }) {
  return (
    `${input.from} ${CHILD_TASK_MARK} “${input.parentTitle}” and waits for your report.\n\n` +
    `${input.instructions}\n\n` +
    'When you are done, call `report` once with what you found, then end your turn.'
  )
}

/** The note a parent wakes up to when the children it waits for have reported. */
export function batchNote(
  finished: { id: string; title: string; teammate: string; report: ChildReport }[],
  unfinished: { id: string; title: string; teammate: string }[],
) {
  const lines = [
    finished.length === 1 && !unfinished.length
      ? 'The child thread you were waiting for has finished:'
      : finished.length
        ? `${finished.length} child threads you were waiting for have finished:`
        : 'You stopped waiting for your child threads: none has finished yet.',
    ...finished.map(
      (c) =>
        `- ${c.teammate} · “${c.title}” (${c.id}): ${STATUS_WORDS[c.report.status]}. ${line(c.report.summary)}`,
    ),
  ]
  if (unfinished.length)
    lines.push(
      '',
      'Still working past the time you gave them (each tells you later, only if it has something to say):',
      ...unfinished.map((c) => `- ${c.teammate} · “${c.title}” (${c.id})`),
    )
  lines.push(
    '',
    '`read_child` gives a child’s full report and what it produced. To tell one more, ' +
      '`message_thread` with its threadId: it carries on and reports again. ' +
      'Then go on with the work or tell the person where things stand.',
  )
  return lines.join('\n')
}

/** The note for one report nobody was waiting for: a schedule's run, or a child after its wait ran out. */
export function singleNote(child: {
  id: string
  title: string
  teammate: string
  schedule: string | null
  report: ChildReport
}) {
  return (
    (child.schedule
      ? `A run of your schedule “${child.schedule}” (child thread “${child.title}”, ${child.id}) ${STATUS_WORDS[child.report.status]}:`
      : `Your child thread “${child.title}” (${child.id}, ${child.teammate}) ${STATUS_WORDS[child.report.status]} after you stopped waiting for it:`) +
    `\n\n${clipReport(child.report.summary, 2_000)}\n\n` +
    '`read_child` gives its full report and what it produced. Act on it if it needs you to, ' +
    'or tell the person in a line.'
  )
}

/** How a note to a thread that follows another begins (followNote): what says it is one. */
const FOLLOW_HEAD = 'The thread you follow “'

/** The note a thread wakes up to when a thread it follows (follow_thread) has reported. */
export function followNote(thread: {
  id: string
  title: string
  teammate: string
  report: ChildReport
}) {
  return (
    `${FOLLOW_HEAD}${thread.title}” (${thread.id}, ${thread.teammate}) ${STATUS_WORDS[thread.report.status]}:` +
    `\n\n${clipReport(thread.report.summary, 2_000)}\n\n` +
    '`read_child` with its threadId gives its full report and what it produced. Go on with your own work ' +
    '(e.g. answer the person who reported it), or tell the person in a line. If it reports again, you hear again.'
  )
}

/** A report nobody waited for wakes the parent only when it has something to say. */
export const wakesParent = (status: ChildReportStatus) => status === 'report' || status === 'failed'

/** How each note to a parent begins (batchNote, singleNote): what says it is one (childNote). */
const REPORT_HEADS = [
  /^The child thread you were waiting for has finished:/,
  /^\d+ child threads you were waiting for have finished:/,
  /^You stopped waiting for your child threads:/,
  /^A run of your schedule “/,
  /^Your child thread “/,
]

/** How the note that a playbook's dry run is done begins (src/playbook-dry-runs.ts in the API). */
export const DRY_RUN_HEAD = 'The dry run of the playbook '

/**
 * Whether a message nobody typed is Brigade's, about child threads: a child's work
 * from its parent (task), reports brought to a parent (report) or to a thread that follows
 * one (follow); or that a playbook's dry run is done (dry_run). The dashboard shows those as
 * notes rather than as a person's message.
 */
export function childNote(text: string): 'task' | 'report' | 'follow' | 'dry_run' | null {
  if (REPORT_HEADS.some((head) => head.test(text))) return 'report'
  if (text.startsWith(FOLLOW_HEAD)) return 'follow'
  if (text.startsWith(DRY_RUN_HEAD)) return 'dry_run'
  const first = text.split('\n', 1)[0] ?? ''
  if (first.includes(` ${CHILD_TASK_MARK} “`) && first.endsWith('and waits for your report.'))
    return 'task'
  return null
}
