// Tasks: work to see finished, on the Tasks board. Each task has at most one
// thread, which is its comments and progress.
import { z } from 'zod'

export const TaskPriority = z.enum(['low', 'medium', 'high', 'urgent'])
export type TaskPriority = z.infer<typeof TaskPriority>

/**
 * Where a task sits on the board, from its thread: none is backlog; an open
 * ticket, a waiting thread, or a pull request it opened and stopped at is
 * needs_you; done once marked done or its pull request merged.
 */
export const TaskColumn = z.enum(['backlog', 'needs_you', 'doing', 'done'])
export type TaskColumn = z.infer<typeof TaskColumn>

/** Something a task produced, where the next teammate or a person can reach it. */
export const TaskDeliverable = z.object({
  label: z.string().trim().min(1).max(200),
  url: z.url({ protocol: /^https?$/ }).max(2000),
})
export type TaskDeliverable = z.infer<typeof TaskDeliverable>

const Title = z.string().trim().min(1).max(200)
const Description = z.string().trim().max(20_000)

/**
 * By hand, or from a thread (it becomes the task's thread). With a teammate,
 * its thread starts at once; without one, it waits in Backlog.
 */
export const CreateTask = z.object({
  title: Title,
  description: Description.default(''),
  priority: TaskPriority.default('medium'),
  /** Unset with a thread: the teammate who answered it last. Unset without: Backlog. */
  teammateId: z.string().optional(),
  sessionId: z.string().optional(),
  /** Unset with a thread: the thread's project. */
  projectId: z.string().nullish(),
  /** The mission it goes in; it takes the mission's project. */
  parentId: z.string().optional(),
})

export const UpdateTask = z.object({
  title: Title.optional(),
  description: Description.optional(),
  priority: TaskPriority.optional(),
  /** Null: out of its project. Its thread follows. */
  projectId: z.string().nullable().optional(),
  /** Into a mission (it takes the mission's project), or null: out of its mission. */
  parentId: z.string().nullable().optional(),
})

/**
 * A teammate takes the task. In Backlog its thread starts, with the brief as
 * the first message; with a thread, the teammate joins it and takes over.
 */
export const AssignTask = z.object({
  teammateId: z.string(),
  /** Why, for the new teammate: what was wrong with the work so far. */
  reason: z.string().trim().max(5000).default(''),
})

export const CompleteTask = z.object({ summary: z.string().trim().max(5000).optional() })

const Summary = z.string().trim().min(1).max(5000)

/**
 * A teammate's task tools, sent by the runner and checked by the API. A
 * teammate never assigns a task to a person nor moves it to Needs you: it
 * opens a ticket, and the task moves there.
 */
export const TaskOperation = z.discriminatedUnion('name', [
  z.object({
    name: z.literal('create'),
    title: Title,
    description: Description.default(''),
    priority: TaskPriority.default('medium'),
    /**
     * self: this thread becomes the task. none: into Backlog. A teammate id:
     * a new task, its thread started for that teammate.
     */
    assignee: z.string().default('self'),
    /** The id of the mission it goes in. */
    mission: z.string().optional(),
    /** A project's id or name, or null: none. Unset: the calling thread's. Not with a mission. */
    project: z.string().nullable().optional(),
  }),
  z.object({ name: z.literal('list') }),
  /** To a started task's thread (taskId), or to a child of the thread calling (threadId). */
  z
    .object({
      name: z.literal('comment'),
      taskId: z.string().optional(),
      threadId: z.string().optional(),
      text: Description.min(1),
    })
    .refine((v) => !!v.taskId !== !!v.threadId, { message: 'Give either taskId or threadId' }),
  z.object({
    name: z.literal('update'),
    taskId: z.string(),
    title: Title.optional(),
    description: Description.optional(),
    priority: TaskPriority.optional(),
    /** Into that mission, or null: out of its mission. */
    mission: z.string().nullable().optional(),
    /** Into a project (id or name), or null: out of its project. Not for a task in a mission. */
    project: z.string().nullable().optional(),
  }),
  z.object({
    name: z.literal('assign'),
    taskId: z.string(),
    teammateId: z.string(),
    reason: z.string().trim().max(5000).default(''),
  }),
  z.object({
    name: z.literal('move'),
    taskId: z.string(),
    to: z.enum(['doing', 'archived', 'trash']),
  }),
  z.object({
    name: z.literal('complete'),
    /** Unset: this thread's task. */
    taskId: z.string().optional(),
    summary: Summary,
    deliverables: z.array(TaskDeliverable).max(20).default([]),
  }),
])
export type TaskOperation = z.infer<typeof TaskOperation>

/** A teammate's comment on a task (comment_task), as the task's thread gets it. */
export const taskComment = (c: { from: string; threadTitle: string; text: string }) =>
  `**${c.from}** commented from the thread “${c.threadTitle}”:\n\n${c.text}`

const COMMENT_HEAD = /^\*\*(.+?)\*\* commented from the thread “(.*)”:\n\n/

/** A task comment read back (taskComment): who wrote it, from where, and what. */
export function fromTaskComment(text: string) {
  const m = COMMENT_HEAD.exec(text)
  return m ? { from: m[1]!, threadTitle: m[2]!, text: text.slice(m[0].length) } : null
}
