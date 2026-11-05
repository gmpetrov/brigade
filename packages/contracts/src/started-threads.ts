// Threads a teammate starts that go on by themselves, at the top level, rather than report back
// as a child: a goal of its own that came up elsewhere, work for another teammate, a list's line
// a routine hands over (start_thread). The thread that started one may write in it later
// (message_thread), as in its own children. They replaced the Tasks board's create_task
// (docs/hand-offs.md).
import { z } from 'zod'

const Text = z.string().trim().min(1)
const Ref = z.string().trim().min(1).max(2_000)

/** A teammate's start_thread and message_thread, as schedule.call operations. */
export const StartedThreadOperations = [
  z.object({
    name: z.literal('start_thread'),
    title: Text.max(120),
    /** What to do, standing alone: the goal, what done looks like, where the specs are. */
    brief: Text.max(20_000),
    /** A teammate's id or name; unset: the teammate calling. */
    teammate: z.string().trim().min(1).max(200).optional(),
    /** A project's id or name, or null: none. Unset: the calling thread's. */
    project: z.string().trim().min(1).max(200).nullable().optional(),
    /** A list's library path, whose lines `items` names. */
    list: z.string().trim().min(1).max(1_000).optional(),
    /** Lines of `list` the thread works on, by id or text: linked before its first turn. */
    items: z.array(Ref).min(1).max(50).optional(),
  }),
  /** To a child of the thread calling, or a thread it started (start_thread). */
  z.object({
    name: z.literal('message_thread'),
    threadId: Text.max(64),
    text: Text.max(20_000),
  }),
] as const

/** The first message of a thread a teammate started (start_thread): who, from where, and the brief. */
export const startedThreadBrief = (b: {
  from: string
  threadTitle: string
  title: string
  brief: string
}) =>
  `**${b.from}** started this thread from the thread “${b.threadTitle}”:\n\n` +
  [`**${b.title}**`, b.brief].filter(Boolean).join('\n\n')

const STARTED_HEAD = /^\*\*(.+?)\*\* started this thread from the thread “(.*)”:\n\n/

/** A started thread's brief read back (startedThreadBrief): who started it, from where, and the brief. */
export function fromStartedThreadBrief(text: string) {
  const m = STARTED_HEAD.exec(text)
  return m ? { from: m[1]!, threadTitle: m[2]!, text: text.slice(m[0].length) } : null
}

/** A teammate's message from another thread (message_thread), as the thread written in gets it. */
export const threadComment = (c: { from: string; threadTitle: string; text: string }) =>
  `**${c.from}** commented from the thread “${c.threadTitle}”:\n\n${c.text}`

const COMMENT_HEAD = /^\*\*(.+?)\*\* commented from the thread “(.*)”:\n\n/

/** A message from another thread read back (threadComment): who wrote it, from where, and what. */
export function fromThreadComment(text: string) {
  const m = COMMENT_HEAD.exec(text)
  return m ? { from: m[1]!, threadTitle: m[2]!, text: text.slice(m[0].length) } : null
}
