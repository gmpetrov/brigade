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

/** By hand into Backlog, or from a thread (it becomes the task's thread). */
export const CreateTask = z.object({
  title: Title,
  description: Description.default(''),
  priority: TaskPriority.default('medium'),
  /** Unset with a thread: the teammate who answered it last. */
  teammateId: z.string().optional(),
  sessionId: z.string().optional(),
})

export const UpdateTask = z.object({
  title: Title.optional(),
  description: Description.optional(),
  priority: TaskPriority.optional(),
})

/** Start a backlog task's thread on a computer, with its brief as the first message. */
export const StartTask = z.object({
  computerId: z.string(),
  accountId: z.string().optional(),
})

export const ReassignTask = z.object({
  teammateId: z.string(),
  /** Why, for the new teammate: what was wrong with the work so far. */
  reason: z.string().trim().max(5000).default(''),
})

export const CompleteTask = z.object({ summary: z.string().trim().max(5000).optional() })

/** A teammate's task tools, sent by the runner and checked by the API. */
export const TaskOperation = z.discriminatedUnion('name', [
  z.object({
    name: z.literal('create'),
    title: Title,
    description: Description.default(''),
    priority: TaskPriority.default('medium'),
  }),
  z.object({
    name: z.literal('complete'),
    summary: z.string().trim().min(1).max(5000),
    deliverables: z.array(TaskDeliverable).max(20).default([]),
  }),
])
export type TaskOperation = z.infer<typeof TaskOperation>
