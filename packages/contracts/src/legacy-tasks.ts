// The Tasks board is gone (docs/hand-offs.md). What stays of it: the task tools runners before
// protocol 52 still send (task.call), which the API answers with what replaced them, and the
// brief a task thread started with, which old threads still show.
import { z } from 'zod'

const Title = z.string().trim().min(1).max(200)
const Description = z.string().trim().max(20_000)
const Priority = z.enum(['low', 'medium', 'high', 'urgent'])

/**
 * The task tools of a runner before protocol 52, as it sends them. The API answers each with what
 * replaced it (src/legacy-tasks.ts): a thread started for a teammate, a message to a thread, the
 * thread declared done; the board's own changes are refused.
 */
export const TaskOperation = z.discriminatedUnion('name', [
  z.object({
    name: z.literal('create'),
    title: Title,
    description: Description.default(''),
    priority: Priority.default('medium'),
    /** self: this thread. none: the Backlog. Else a teammate's id or name: a thread for it. */
    assignee: z.string().default('self'),
    mission: z.string().optional(),
    project: z.string().nullable().optional(),
  }),
  z.object({ name: z.literal('list') }),
  /** To a task's thread (taskId), or to a child of the thread calling (threadId). */
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
    priority: Priority.optional(),
    mission: z.string().nullable().optional(),
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
    taskId: z.string().optional(),
    summary: z.string().trim().min(1).max(5000),
    deliverables: z
      .array(
        z.object({
          label: z.string().trim().min(1).max(200),
          url: z.url({ protocol: /^https?$/ }).max(2000),
        }),
      )
      .max(20)
      .default([]),
  }),
])
export type TaskOperation = z.infer<typeof TaskOperation>

const BRIEF_HEAD = /^\*\*(.+?)\*\* started this task from the thread “(.*)”:\n\n/

/** The brief an old task's thread started with: who started it, from where, and the brief. */
export function fromTaskBrief(text: string) {
  const m = BRIEF_HEAD.exec(text)
  return m ? { from: m[1]!, threadTitle: m[2]!, text: text.slice(m[0].length) } : null
}
