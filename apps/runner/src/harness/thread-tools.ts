// Brigade's tools that act for the whole thread, refused to a teammate's sub-agents (Claude
// Code's Agent tool). A sub-agent gets every tool the thread has, but sees only its own part of
// the work: one that called the thread's report sent its partial result to the parent as the
// child's final one. Claude Code tells the bridge's PreToolUse hook which calls a sub-agent
// makes (the hook input's agent_id), and the bridge refuses these there, with REFUSAL
// (patches/@ai-sdk__harness-claude-code). Codex's sub-agents run as threads of their own,
// whose calls to any Brigade tool its bridge refuses (patches/@ai-sdk__harness-codex).
//
// A sub-agent keeps the tools that do the work (files, code, searches, the library, previews,
// Apps' reads and writes): only those that speak or decide for the thread stay its own.

/** The MCP server Claude Code finds Brigade's tools under (the bridge's harness-tools). */
const PREFIX = 'mcp__harness-tools__'

/** App tools that are the thread's alone, through whichever account. */
const APP_TOOLS = [
  'github_create_pull_request',
  'github_mark_ready_for_review',
  'github_review_pull_request',
  'github_merge_pull_request',
]

/**
 * An App tool's names: bare with one account of the App, suffixed with the account's when there
 * are several (connectorTools).
 */
const appTool = (name: string) => [name, `${name}_*`]

/** Brigade's tools that are the thread's alone, by name; a name ending in "*" is a prefix. */
export const THREAD_TOOLS = [
  // Its result and its end: a child's report, a playbook run's case and outcome, the task and
  // list items it was given.
  'report',
  'playbook_triage',
  'playbook_report',
  'complete_task',
  'complete_item',
  // What it waits on and what wakes it: child threads, wake-ups and reviews, whose news comes
  // back to the thread, not to the sub-agent that asked.
  'start_child',
  'cancel_child',
  'set_wakeup',
  'cancel_wakeup',
  'request_review',
  'start_dry_run',
  // What it says to people and other threads: a ticket stops for a person, a message speaks as
  // the thread.
  'open_ticket',
  'message_thread',
  // Work the thread then owns and answers for: tasks, routines, playbooks and pull requests
  // (opening, readying, reviewing and merging one are its decisions: a review a sub-agent posted
  // would stand as the thread's verdict).
  'create_task',
  'create_schedule',
  'update_schedule',
  'create_trigger',
  'configure_playbook',
  'activate_playbook',
  'update_playbook',
  ...APP_TOOLS.flatMap(appTool),
]

/** What a sub-agent is told for one of them; {tool} is the tool's name. */
export const REFUSAL =
  'Only the thread itself may call {tool}: you are a sub-agent working for it. Do not try again ' +
  'and do not look for another way to do it: put what you found, or what you would have done ' +
  'with {tool}, in your final answer. The thread reads it and calls {tool} itself if it should.'

/** The environment that has the Claude Code bridge refuse them to sub-agents. */
export const threadToolsEnv = (): Record<string, string> => ({
  BRIGADE_THREAD_TOOLS: JSON.stringify({
    tools: THREAD_TOOLS.map((name) => PREFIX + name),
    refusal: REFUSAL,
  }),
})
