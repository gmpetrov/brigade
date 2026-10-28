// A long thread opens on its latest page of events; older pages load as
// someone scrolls up. What the whole thread needs comes along as context.
import type { AgentEventType } from './events.js'

/** About how many events a page of a thread holds; a page never splits a turn. */
export const THREAD_PAGE_EVENTS = 2000

/**
 * The most messages a page holds: a thread of many short exchanges would otherwise put
 * hundreds of them on the screen at once, each with its replies, more than a browser draws
 * in reasonable time.
 */
export const THREAD_PAGE_MESSAGES = 30

/** Where a page may start: a member's message or a turn, never inside a reply. */
export const THREAD_PAGE_STARTS: AgentEventType[] = ['message.user', 'turn.started']

/**
 * A person's message in a thread, for the timeline beside a long one: where it is and
 * its first words only, so the whole thread's list stays small.
 */
export type TimelineMessage = {
  seq: number
  at: string
  text: string
  /** How many messages the mark stands for, from this one: more than one in a long thread. */
  count: number
  /** The last of them. */
  last: number
}

/** The most marks a timeline shows: past that, each stands for several messages in a row. */
export const THREAD_TIMELINE_MARKS = 50

/**
 * Which mark the i-th of n messages goes in: n marks up to THREAD_TIMELINE_MARKS, else
 * that many, each with as many messages in a row as the others, give or take one. The
 * API groups in its query by the same rule (threadPrompts).
 */
export const markOf = (i: number, n: number) =>
  Math.floor((i * Math.min(n, THREAD_TIMELINE_MARKS)) / n)

/** Messages, oldest first, as marks: each the first message of its group. */
export function groupMarks(messages: Omit<TimelineMessage, 'count' | 'last'>[]): TimelineMessage[] {
  const marks: TimelineMessage[] = []
  messages.forEach((m, i) => {
    const mark = markOf(i, messages.length)
    const open = marks[mark]
    if (open) {
      open.count++
      open.last = m.seq
    } else marks[mark] = { ...m, count: 1, last: m.seq }
  })
  return marks
}

/** How much of each message the timeline gets: enough for a line or two on hover. */
export const THREAD_PROMPT_CHARS = 160

/** Files made to hand over, not code a teammate read or wrote to make them. */
export const DELIVERABLE_EXTENSIONS =
  'pdf|docx?|xlsx?|pptx?|odt|ods|odp|csv|zip|png|jpe?g|gif|webp|svg|mp3|mp4|wav'
export const DELIVERABLE_FILE = new RegExp(`\\.(?:${DELIVERABLE_EXTENSIONS})$`, 'i')

/** The bare tool name, without an MCP server's `mcp__server__` prefix. */
export const bareToolName = (toolName: string) => toolName.replace(/^mcp__.+?__/, '')

/**
 * Whether a bare tool name is a connector's operation. With several connections of one
 * kind, each operation's tool name ends in its account (`github_create_pull_request_acme`).
 */
export const isOperation = (tool: string, operation: string) =>
  tool === operation || tool.startsWith(`${operation}_`)

/** Tools whose calls show among what a thread made. */
export const OUTPUT_TOOLS = [
  'save_to_library',
  // Not shown themselves: they move or remove what was saved.
  'move_in_library',
  'delete_from_library',
  'save_design',
  'save_design_system',
  'github_create_pull_request',
  'create_schedule',
  'propose_skill',
]
/** Email a teammate sent or drafted: a bare tool name, from a tool whose full name says mail. */
export const EMAIL_TOOL = /^(?:gmail_)?(?:send|send_message|create_draft|reply|forward)(?:_\w+)?$/

export function isOutputTool(toolName: string) {
  const tool = bareToolName(toolName)
  return (
    OUTPUT_TOOLS.includes(tool) ||
    isOperation(tool, 'github_create_pull_request') ||
    (EMAIL_TOOL.test(tool) && /gmail|mail/i.test(toolName))
  )
}
