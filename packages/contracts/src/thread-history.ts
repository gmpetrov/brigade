// A long thread opens on its latest page of events; older pages load as
// someone scrolls up. What the whole thread needs comes along as context.
import type { AgentEventType } from './events.js'

/** About how many events a page of a thread holds; a page never splits a turn. */
export const THREAD_PAGE_EVENTS = 2000

/** Where a page may start: a member's message or a turn, never inside a reply. */
export const THREAD_PAGE_STARTS: AgentEventType[] = ['message.user', 'turn.started']

/** Files made to hand over, not code a teammate read or wrote to make them. */
export const DELIVERABLE_EXTENSIONS =
  'pdf|docx?|xlsx?|pptx?|odt|ods|odp|csv|zip|png|jpe?g|gif|webp|svg|mp3|mp4|wav'
export const DELIVERABLE_FILE = new RegExp(`\\.(?:${DELIVERABLE_EXTENSIONS})$`, 'i')

/** The bare tool name, without an MCP server's `mcp__server__` prefix. */
export const bareToolName = (toolName: string) => toolName.replace(/^mcp__.+?__/, '')

/** Tools whose calls show among what a thread made. */
export const OUTPUT_TOOLS = [
  'save_to_library',
  'save_design',
  'save_design_system',
  'github_create_pull_request',
  'create_schedule',
  'propose_skill',
]
/** Email a teammate sent or drafted: a bare tool name, from a tool whose full name says mail. */
export const EMAIL_TOOL = /^(?:gmail_)?(?:send|send_message|create_draft|reply|forward)$/

export function isOutputTool(toolName: string) {
  const tool = bareToolName(toolName)
  return OUTPUT_TOOLS.includes(tool) || (EMAIL_TOOL.test(tool) && /gmail|mail/i.test(toolName))
}
