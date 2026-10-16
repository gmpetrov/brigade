// Whether a teammate's turn gave the person a reply, and what to ask for when
// it did not. Claude Code asks on its own when its last answer in a turn has no
// text, even when the reply came before a later tool call (a card, its plan, a
// wake-up): told it showed nothing, the teammate wrote its answer a second time.
// The runner tells Claude Code that every tool may end a turn (terminalTools),
// and asks itself, once, when the turn is over and it knows all of it.
import { ASIDE_TOOLS, bareToolName, hasVisibleText, type AgentEvent } from '@brigade/contracts'

/** For a turn that ended with nothing the person can read. */
export const NO_REPLY =
  'Your turn ended without a reply the person can read: they never see your thinking or your tool calls. ' +
  'Write your reply now, as text. A card you showed stays under it: do not show it again.'

/** For a turn that ended on a step of work, or on a message steered into it, with text before it. */
export const AFTER_STEP =
  "Your turn ended with nothing written after your last step of work or the person's latest message. They " +
  'read what you wrote before it, so do not repeat that: write what they need to know since, as text, in a ' +
  'line when that is enough. A card you showed stays under it: do not show it again.'

/**
 * What the person has read of a teammate's turn: nothing yet, text with a step
 * of work after it, or text after its last step (asides such as a card do not
 * count as work). Unknown after a restart, since what came before it is not
 * here, and once a reply was asked for: then none is asked for.
 */
export class ReplyWatch {
  private read: 'nothing' | 'before' | 'after' | 'unknown' = 'unknown'

  /** A person's message starts the turn. */
  start() {
    this.read = 'nothing'
  }

  /** A person's message steered into the turn: it needs a reply of its own, after what they read. */
  steered() {
    this.owe()
  }

  /** The turn goes on after a restart. */
  resume() {
    this.read = 'unknown'
  }

  see(event: AgentEvent) {
    if (event.type === 'message.done' && hasVisibleText(event.text)) this.read = 'after'
    else if (event.type === 'tool.started' && !ASIDE_TOOLS.has(bareToolName(event.toolName)))
      this.owe()
  }

  /** What the person read came before something that needs a reply of its own. */
  private owe() {
    if (this.read === 'after') this.read = 'before'
  }

  /** What to tell the teammate once its turn is over, if it owes the person a reply. Asked once. */
  ask(): string | undefined {
    const ask = this.read === 'nothing' ? NO_REPLY : this.read === 'before' ? AFTER_STEP : undefined
    if (ask) this.read = 'unknown'
    return ask
  }
}

/**
 * Claude Code's own tools, by the name the model calls them. Brigade's are its
 * MCP server's (`mcp__harness-tools__<name>`).
 */
const CLAUDE_CODE_TOOLS = [
  'Agent',
  'Bash',
  'Edit',
  'EnterWorktree',
  'ExitPlanMode',
  'ExitWorktree',
  'Glob',
  'Grep',
  'ListAgents',
  'ListMcpResources',
  'Monitor',
  'NotebookEdit',
  'Read',
  'ReadMcpResource',
  'SendMessage',
  'Skill',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'TaskUpdate',
  'TodoWrite',
  'ToolSearch',
  'WebFetch',
  'WebSearch',
  'Write',
]

/** The browser's tools a teammate that browses calls at least one of (Playwright MCP's). */
const BROWSER_TOOLS = [
  'browser_click',
  'browser_evaluate',
  'browser_fill_form',
  'browser_navigate',
  'browser_run_code_unsafe',
  'browser_snapshot',
  'browser_tabs',
  'browser_take_screenshot',
  'browser_type',
  'browser_wait_for',
]

/**
 * The environment that keeps Claude Code from asking for a reply in a turn where
 * one of these tools succeeded: the runner asks instead (ReplyWatch). A turn
 * with no tool call has a single answer, which Claude Code still checks itself.
 */
export function terminalTools(brigadeTools: string[]) {
  return {
    CLAUDE_CODE_TERMINAL_MCP_TOOLS: [
      ...CLAUDE_CODE_TOOLS,
      ...BROWSER_TOOLS.map((name) => `mcp__browser__${name}`),
      ...brigadeTools.map((name) => `mcp__harness-tools__${name}`),
    ].join(','),
  }
}
