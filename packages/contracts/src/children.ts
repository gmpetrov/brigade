// Child threads: a teammate starts work in a thread of its own, in a fresh
// context, and its report comes back to the thread it was started from. The
// parent is woken once every child it waits for has reported (src/children.ts
// in the API). A schedule made from a thread reports there the same way.
import { z } from 'zod'
import { ATTACHMENTS_PER_MESSAGE } from './attachments.js'

/**
 * How deep sub-threads go (docs/sub-threads.md): a thread at the top starts sub-threads (level 1),
 * which may start their own (level 2); those start none. The API enforces it, the runner tells the
 * teammates. Internal, not a setting: changing it is this line.
 */
export const SUBTHREAD_DEPTH = 2
/**
 * Sub-threads at work at once in one tree (a thread at the top and every sub-thread under it, at
 * both levels): the next start_child is refused until one reports. Internal, not a setting.
 */
export const SUBTHREADS_AT_WORK = 8
/** How long a parent waits for its awaited children by default, then hears what is done. */
export const CHILD_WAIT_MINUTES = 24 * 60
/** The longest a parent may choose to wait. */
export const CHILD_WAIT_MAX_MINUTES = 7 * 24 * 60
/** Threads that may follow one thread (follow_thread). */
export const FOLLOWERS_PER_THREAD = 20
/**
 * A child a person talks with does not report each answer: once they have been quiet this
 * long without it calling `report`, its last message goes to its parent as its report.
 */
export const REPORT_AFTER_PERSON_MINUTES = 30
/**
 * Longest report: the answer first, then all its parent needs (a review's findings, the
 * results). Notes, list_children and the dashboard show its start (REPORT_START);
 * read_child gives it whole.
 */
export const REPORT_MAX = 40_000
/** What a parent's note, list_children and the dashboard show of a report. */
export const REPORT_START = 2_000
/** Files one report sends its parent, as many as one message carries. */
export const REPORT_FILES_MAX = ATTACHMENTS_PER_MESSAGE

/**
 * nothing: nothing worth telling (a schedule's run with nothing new). report: something to say.
 * needs_person: the work cannot go on without a person. needs_parent: it needs a decision its
 * parent can make, which wakes the parent at once (SUBTHREADS_PROTOCOL). failed: it could not do
 * the work. cancelled: its parent stopped it (set by Brigade, not by the child).
 */
export const ChildReportStatus = z.enum([
  'nothing',
  'report',
  'needs_person',
  'needs_parent',
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
  /** It ends a conversation a person had with it in the child (REPORT_AFTER_PERSON_MINUTES, or sent by them). */
  afterPerson: z.boolean().optional(),
  /** The files it sent with it: where each is in its parent's working folder (attachments/…). */
  files: z.array(z.string()).optional(),
})
export type ChildReport = z.infer<typeof ChildReport>

const Text = z.string().trim().min(1)

/**
 * Where a sub-thread runs (start_child's `computer`): `same`, its parent's computer; `cloud`, the
 * workspace's cloud computer; `mine`, a machine of the member the tree works for (its only one,
 * or the one named). Never another member's machine.
 */
export const SubthreadComputer = z.union([
  z.enum(['same', 'cloud', 'mine']),
  /** One of that member's machines, by its name ("Georges's MacBook"). */
  z.object({ mine: z.string().trim().min(1).max(200) }),
])
export type SubthreadComputer = z.infer<typeof SubthreadComputer>

/** A branch a sub-thread starts from: its parent's runner pushes it first. */
export const SubthreadRepo = z.object({
  repository: z
    .string()
    .trim()
    .regex(/^[\w.-]+\/[\w.-]+$/, 'owner/name'),
  branch: z.string().trim().min(1).max(250),
})
export type SubthreadRepo = z.infer<typeof SubthreadRepo>

/** Branches one start_child hands over. */
export const SUBTHREAD_REPOS_MAX = 5

/**
 * all: the parent is woken once every sub-thread it waits for has reported. each: every report of
 * this one wakes it (those that come during one of its turns come together on its next).
 */
export const SubthreadWake = z.enum(['all', 'each'])
export type SubthreadWake = z.infer<typeof SubthreadWake>

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
    /** SUBTHREADS_PROTOCOL: where it runs. Unset: its parent's computer, as before. */
    computer: SubthreadComputer.optional(),
    /** SUBTHREADS_PROTOCOL: files for it, by id (POST /runner/attachments first), in its working folder. */
    files: z.array(z.string().min(1).max(64)).max(REPORT_FILES_MAX).optional(),
    /** SUBTHREADS_PROTOCOL: branches it starts from, pushed by its parent's runner first. */
    repos: z.array(SubthreadRepo).max(SUBTHREAD_REPOS_MAX).optional(),
    /** SUBTHREADS_PROTOCOL: when its reports wake the parent. Unset: all, as before. */
    wake: SubthreadWake.optional(),
  }),
  z.object({ name: z.literal('list_children') }),
  z.object({ name: z.literal('read_child'), threadId: z.string() }),
  z.object({ name: z.literal('cancel_child'), threadId: z.string() }),
  /**
   * Be woken by another thread's report, like its parent: any thread the teammate may write in
   * (message_thread's check), e.g. a sub-thread of the same tree or a builder thread; before
   * SUBTHREADS_PROTOCOL, only a child of another run of the same playbook.
   */
  z.object({ name: z.literal('follow_thread'), threadId: z.string().trim().min(1) }),
  /** In a child: what it found, for its parent. Sent on when its turn ends. */
  z.object({
    name: z.literal('report'),
    status: z.enum(['nothing', 'report', 'needs_person', 'needs_parent', 'failed']),
    summary: Text.max(REPORT_MAX),
    /** Files for its parent, by id: the runner sent them first (POST /runner/attachments). */
    files: z.array(z.string().min(1).max(64)).max(REPORT_FILES_MAX).optional(),
  }),
] as const

/**
 * What a sub-thread is at, as a thread's Tree section shows it (GET /threads/:id/tree): working;
 * waiting for its own sub-threads; needs a person; needs its parent (needs_parent); failed;
 * done (reported); cancelled; or idle.
 */
export type TreeNodeState =
  'working' | 'waiting' | 'needs_you' | 'needs_parent' | 'failed' | 'done' | 'cancelled' | 'idle'

/** A sub-thread in its tree (GET /threads/:id/tree). */
export type TreeNode = {
  id: string
  title: string
  parentId: string
  /** 1 under the thread at the top, 2 under a sub-thread. */
  level: number
  teammate: { id: string; name: string }
  computer: { id: string; name: string; kind: string }
  status: string
  state: TreeNodeState
  report: { status: ChildReportStatus; summary: string } | null
  /** The line of a list it works on, as last seen. */
  line: string | null
  pullRequests: { repository: string; number: number; state: string; url: string }[]
  /** Library documents it saved, by path. */
  documents: string[]
  /** Files it sent (a report's, an upload). */
  files: number
  tokens: number
  createdAt: string
}

/**
 * A thread's tree below it: its own level, the thread at the top, its sub-threads and theirs
 * (depth first), and tokens: its own, those below it, and the whole tree's from the top.
 */
export type ThreadTree = {
  level: number
  rootId: string
  nodes: TreeNode[]
  tokens: { thread: number; below: number; tree: number }
}

/** In a child's first message, after its parent's teammate: what says it is one (childNote). */
const CHILD_TASK_MARK = 'started this thread from the thread'

/** Text cut to `max` characters, with an ellipsis when it was longer. */
export const clipReport = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text

/** One line of a report, for a note: no line breaks, kept short. */
const line = (text: string) => clipReport(text.replace(/\s+/g, ' ').trim(), 400)

/**
 * Where the files a report sent are, for its note: in the parent's working folder. As code,
 * each opens beside the thread for people reading the note.
 */
const sentFiles = (report: ChildReport) =>
  report.files?.length
    ? `Files it sent (in your working folder): ${report.files.map((f) => `\`${f}\``).join(', ')}.`
    : ''

const STATUS_WORDS: Record<ChildReportStatus, string> = {
  nothing: 'nothing new',
  report: 'reports',
  needs_person: 'needs a person',
  needs_parent: 'needs its parent',
  failed: 'failed',
  cancelled: 'cancelled',
}

/** How each note ends: what to do next, for the teammate only (forPeople leaves it out). */
const CHILD_HINT =
  'When you are done, call `report` once, then end your turn. The thread that started you cannot ' +
  'see your files, /tmp included: put in your report all it needs, the answer first, and send the ' +
  'files it needs (scripts, logs, screenshots) with it, in `files`.'
/** CHILD_HINT as children were told it before, still in their first messages. */
const CHILD_HINT_BEFORE =
  'When you are done, call `report` once with what you found, then end your turn.'
/** After a needs_parent report: the parent answers, and the sub-thread goes on. */
const NEEDS_PARENT_HINT =
  'It waits on you: answer it with `message_thread` and its threadId, and it goes on. Ask the ' +
  'person (a ticket) only if you cannot decide it yourself; if your own parent can, report ' +
  '`needs_parent` to it.'
const BATCH_HINT =
  '`read_child` gives a child’s full report and what it produced. To tell one more, ' +
  '`message_thread` with its threadId: it carries on and reports again. ' +
  'Then go on with the work or tell the person where things stand.'
const SINGLE_HINT =
  '`read_child` gives its full report and what it produced. Act on it if it needs you to, ' +
  'or tell the person in a line.'
/** After a person talked it through in the child: what they settled there is not asked again. */
const AFTER_PERSON_HINT =
  'A person talked it through with it in that thread, and this is where they left it: do not ask ' +
  'them the same again. ' +
  SINGLE_HINT

/**
 * What a sub-thread is handed with its brief (start_child): where its files are, the branches it
 * starts from, and the computer it runs on when that is not its parent's.
 */
export type ChildInputs = {
  /** Where each file is in its working folder (attachments/…). */
  files?: string[]
  repos?: SubthreadRepo[]
  /** The computer's name, when it runs on another than its parent's. */
  computer?: string
}

const inputsText = (inputs: ChildInputs | undefined) => {
  if (!inputs) return ''
  const lines: string[] = []
  if (inputs.computer) lines.push(`You run on ${inputs.computer}, not on your parent's computer.`)
  if (inputs.files?.length)
    lines.push(
      `Files from your parent (in your working folder): ${inputs.files.map((f) => `\`${f}\``).join(', ')}.`,
    )
  for (const r of inputs.repos ?? [])
    lines.push(
      `Start from \`${r.branch}\` of ${r.repository}: \`checkout_repository\` with base \`${r.branch}\`, ` +
        'and work on a branch of your own from it.',
    )
  return lines.length ? `\n\n${lines.join('\n')}` : ''
}

/** What the child is told with its work: where it comes from and how to finish. */
export function childPrompt(input: {
  from: string
  parentTitle: string
  instructions: string
  inputs?: ChildInputs
}) {
  return (
    `${input.from} ${CHILD_TASK_MARK} “${input.parentTitle}” and waits for your report.\n\n` +
    `${input.instructions}${inputsText(input.inputs)}\n\n` +
    CHILD_HINT
  )
}

/** A report as a note tells it: its start, then where the files it sent are. */
const reportStart = (report: ChildReport) =>
  [clipReport(report.summary, REPORT_START), sentFiles(report)].filter(Boolean).join('\n\n')

/**
 * A review's verdict as Brigade recorded it when the reviewer posted it on GitHub
 * (github_review_pull_request): its latest, and the commit it read.
 */
export type PostedVerdict = {
  /** The pull request it reviews. */
  number: number
  /** null: it has posted none. */
  verdict: 'approve' | 'request_changes' | null
  sha: string | null
}

/**
 * A review's verdict in a sentence, ahead of its report: the report is the reviewer's own
 * words, which may say otherwise ("nothing blocking" under a request for changes); the
 * verdict is what the pull request shows, and what holds its merge back.
 */
export function verdictLine(review: PostedVerdict) {
  if (!review.verdict) return `No verdict posted on GitHub (#${review.number}).`
  const where = `#${review.number}${review.sha ? `, commit ${review.sha.slice(0, 7)}` : ''}`
  return `Verdict posted on GitHub: ${review.verdict === 'approve' ? 'approved' : 'changes requested'} (${where}).`
}

/**
 * The note a parent wakes up to when the children it waits for have reported. A review's
 * verdict comes first on its line, before the report's words.
 */
export function batchNote(
  finished: {
    id: string
    title: string
    teammate: string
    report: ChildReport
    review?: PostedVerdict
  }[],
  unfinished: { id: string; title: string; teammate: string }[],
) {
  const lines = [
    finished.length === 1 && !unfinished.length
      ? 'The child thread you were waiting for has finished:'
      : finished.length
        ? `${finished.length} child threads you were waiting for have finished:`
        : 'You stopped waiting for your child threads: none has finished yet.',
    ...finished.map((c) =>
      [
        `- ${c.teammate} · “${c.title}” (${c.id}): ${STATUS_WORDS[c.report.status]}.`,
        c.review && verdictLine(c.review),
        line(c.report.summary),
        sentFiles(c.report),
      ]
        .filter(Boolean)
        .join(' '),
    ),
  ]
  if (unfinished.length)
    lines.push(
      '',
      'Still working past the time you gave them (each tells you later, only if it has something to say):',
      ...unfinished.map((c) => `- ${c.teammate} · “${c.title}” (${c.id})`),
    )
  lines.push('', BATCH_HINT)
  return lines.join('\n')
}

/**
 * The note for one report nobody was waiting for: a schedule's run, a child started without
 * waiting for it, or one after its wait ran out (late). A review's verdict comes before the
 * report's words.
 */
export function singleNote(child: {
  id: string
  title: string
  teammate: string
  schedule: string | null
  report: ChildReport
  late?: boolean
  review?: PostedVerdict
}) {
  const status = STATUS_WORDS[child.report.status]
  return (
    (child.schedule
      ? `A run of your schedule “${child.schedule}” (child thread “${child.title}”, ${child.id}) ${status}:`
      : `Your child thread “${child.title}” (${child.id}, ${child.teammate}) ${status}${child.late ? ' after you stopped waiting for it' : ''}:`) +
    `\n\n${child.review ? `${verdictLine(child.review)}\n\n` : ''}${reportStart(child.report)}\n\n` +
    (child.report.status === 'needs_parent'
      ? NEEDS_PARENT_HINT
      : child.report.afterPerson
        ? AFTER_PERSON_HINT
        : SINGLE_HINT)
  )
}

/** How a note to a thread that follows another begins (followNote): what says it is one. */
const FOLLOW_HEAD = 'The thread you follow “'

const FOLLOW_HINT =
  '`read_child` with its threadId gives its full report and what it produced. Go on with your own work ' +
  '(e.g. answer the person who reported it), or tell the person in a line. If it reports again, you hear again.'

/** The note a thread wakes up to when a thread it follows (follow_thread) has reported. */
export function followNote(thread: {
  id: string
  title: string
  teammate: string
  report: ChildReport
}) {
  return (
    `${FOLLOW_HEAD}${thread.title}” (${thread.id}, ${thread.teammate}) ${STATUS_WORDS[thread.report.status]}:` +
    `\n\n${reportStart(thread.report)}\n\n` +
    FOLLOW_HINT
  )
}

/**
 * A report nobody waited for wakes the parent only when it has something to say, or needs it.
 * With wake `each`, every report does (Session.wakeEach).
 */
export const wakesParent = (status: ChildReportStatus) =>
  status === 'report' || status === 'failed' || status === 'needs_parent'

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
 * Where a message within a tree (message_thread) comes from, seen from the thread it reaches: its
 * parent, one of its children, a sibling (same parent), or another thread of the tree.
 */
export const TreeRelation = z.enum(['parent', 'child', 'sibling', 'tree'])
export type TreeRelation = z.infer<typeof TreeRelation>

/**
 * How a message from another thread of the tree (message_thread) begins: who, its relation, and
 * that thread's title. `parent` is how a parent's notes always began.
 */
const PARENT_HEAD = /^\*\*(.+?)\*\* wrote from the (parent|child|sibling|tree) thread “(.*)”:\n\n/

/** What a parent's teammate tells its child later (message_thread), as the child receives it. */
export const parentMessage = (input: { from: string; parentTitle: string; text: string }) =>
  treeMessage({ from: input.from, relation: 'parent', title: input.parentTitle, text: input.text })

/** What another thread of the same tree writes (message_thread), as the receiving thread reads it. */
export const treeMessage = (input: {
  from: string
  relation: TreeRelation
  title: string
  text: string
}) => `**${input.from}** wrote from the ${input.relation} thread “${input.title}”:\n\n${input.text}`

/**
 * A message from another thread of the tree (treeMessage) read back: who wrote it, its relation,
 * from where, and what. `parentTitle`: that thread's title, whatever the relation.
 */
export function fromParent(text: string) {
  const m = PARENT_HEAD.exec(text)
  return m
    ? {
        from: m[1]!,
        relation: m[2] as TreeRelation,
        parentTitle: m[3]!,
        text: text.slice(m[0].length),
      }
    : null
}

/**
 * Whether a message nobody typed is Brigade's, about child threads: a child's work
 * from its parent (task) and what its parent tells it later (parent), reports brought to a
 * parent (report) or to a thread that follows one (follow); or that a playbook's dry run is
 * done (dry_run). The dashboard shows those as notes rather than as a person's message.
 */
export function childNote(
  text: string,
): 'task' | 'parent' | 'report' | 'follow' | 'dry_run' | null {
  if (REPORT_HEADS.some((head) => head.test(text))) return 'report'
  if (PARENT_HEAD.test(text)) return 'parent'
  if (text.startsWith(FOLLOW_HEAD)) return 'follow'
  if (text.startsWith(DRY_RUN_HEAD)) return 'dry_run'
  const first = text.split('\n', 1)[0] ?? ''
  if (first.includes(` ${CHILD_TASK_MARK} “`) && first.endsWith('and waits for your report.'))
    return 'task'
  return null
}

/** A thread a note tells about: the dashboard shows it as a line that opens it. */
export type NoteThread = {
  id: string
  title: string
  teammate: string
  /** null: still working when the note was written. */
  status: ChildReportStatus | null
  summary: string
}

const ID = '([a-z0-9]+)'
const STATUS = `(${Object.values(STATUS_WORDS)
  .map((w) => w.replace(/[()]/g, '\\$&'))
  .join('|')})`
const statusOf = (words: string) =>
  (Object.keys(STATUS_WORDS) as ChildReportStatus[]).find((s) => STATUS_WORDS[s] === words)!
const FINISHED_LINE = new RegExp(`^- (.+?) · “(.*?)” \\(${ID}\\): ${STATUS}\\. ?(.*)$`)
const UNFINISHED_LINE = new RegExp(`^- (.+?) · “(.*)” \\(${ID}\\)$`)
const SCHEDULE_HEAD = new RegExp(
  `^A run of your schedule “(.*?)” \\(child thread “(.*)”, ${ID}\\) ${STATUS}:\n\n`,
)
const LATE_HEAD = new RegExp(
  `^Your child thread “(.*)” \\(${ID}, (.+?)\\) ${STATUS} after you stopped waiting for it:\n\n`,
)
const CHILD_HEAD = new RegExp(`^Your child thread “(.*)” \\(${ID}, (.+?)\\) ${STATUS}:\n\n`)
const FOLLOW_LINE = new RegExp(`^${FOLLOW_HEAD}(.*)” \\(${ID}, (.+?)\\) ${STATUS}:\n\n`)

/**
 * The threads a report note (batchNote, singleNote, followNote) tells about, read back from
 * its text for people: a line above them (`head`), then each thread with what it said.
 * null for any other text, which is then shown as it is.
 */
export function noteThreads(text: string): { head: string | null; threads: NoteThread[] } | null {
  const note = forPeople(text)
  let m = SCHEDULE_HEAD.exec(note)
  if (m)
    return {
      head: `A run of the schedule “${m[1]}”`,
      threads: [
        {
          id: m[3]!,
          title: m[2]!,
          teammate: '',
          status: statusOf(m[4]!),
          summary: note.slice(m[0].length),
        },
      ],
    }
  m = LATE_HEAD.exec(note)
  if (m)
    return {
      head: 'Finished after the wait for it ran out',
      threads: [
        {
          id: m[2]!,
          title: m[1]!,
          teammate: m[3]!,
          status: statusOf(m[4]!),
          summary: note.slice(m[0].length),
        },
      ],
    }
  m = CHILD_HEAD.exec(note) ?? FOLLOW_LINE.exec(note)
  if (m)
    return {
      head: null,
      threads: [
        {
          id: m[2]!,
          title: m[1]!,
          teammate: m[3]!,
          status: statusOf(m[4]!),
          summary: note.slice(m[0].length),
        },
      ],
    }
  if (!REPORT_HEADS.slice(0, 3).some((h) => h.test(note))) return null
  const [head, ...rest] = note.split('\n')
  const threads: NoteThread[] = []
  for (const l of rest) {
    const f = FINISHED_LINE.exec(l)
    const u = f ? null : UNFINISHED_LINE.exec(l)
    if (f)
      threads.push({
        id: f[3]!,
        title: f[2]!,
        teammate: f[1]!,
        status: statusOf(f[4]!),
        summary: f[5]!,
      })
    else if (u)
      threads.push({ id: u[3]!, title: u[2]!, teammate: u[1]!, status: null, summary: '' })
    else if (l.trim() && !l.startsWith('Still working past')) return null
  }
  return threads.length ? { head: head!, threads } : null
}

/**
 * Added to a queued message a person sends to run in parallel: the teammate, in the middle of
 * its turn, hands it to a child thread it briefs from this one, then carries on.
 */
const PARALLEL_HINT =
  'The person wants this done in parallel, in a child thread, while you carry on: call ' +
  '`start_child` now with `wait: false`, a short title and instructions that stand alone ' +
  '(what it needs from this thread: the repository and branch, the files or page in question, ' +
  'what was decided so far). Do not do this work yourself here. Then go back to what you were doing.'

/** A person's message, to be handed to a child thread by the teammate in its running turn. */
export const inParallel = (text: string) =>
  asksParallel(text) ? text : `${text.trimEnd()}\n\n${PARALLEL_HINT}`

/** Whether a message was sent to run in parallel (inParallel). */
export const asksParallel = (text: string) => text.endsWith(PARALLEL_HINT)

/**
 * A note about child threads, or a message sent to run in parallel, as people read it:
 * without what it tells the teammate to do next.
 */
export function forPeople(text: string) {
  for (const hint of [
    CHILD_HINT,
    CHILD_HINT_BEFORE,
    BATCH_HINT,
    AFTER_PERSON_HINT,
    NEEDS_PARENT_HINT,
    SINGLE_HINT,
    FOLLOW_HINT,
    PARALLEL_HINT,
  ])
    if (text.endsWith(hint)) return text.slice(0, -hint.length).trimEnd()
  return text
}
