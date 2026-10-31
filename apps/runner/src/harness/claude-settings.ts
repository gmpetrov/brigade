// What Brigade turns off in Claude Code. Claude Code ships its own ways of doing
// what Brigade does (schedules, memory, other sessions, cloud routines, plugins),
// which would work outside Brigade where nobody sees them, and each costs
// context on every turn. They go to Claude Code as settings above every
// settings file (the bridge's BRIGADE_CLAUDE_SETTINGS), so a member's own
// ~/.claude, on a Mac, keeps what it set and loses only these.

/** Claude Code's tools that Brigade does otherwise, by their names in Claude Code. */
const DENIED_TOOLS = [
  // Schedules and wake-ups: create_schedule and set_wakeup, which outlive the session.
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  // Other Claude sessions on this computer, other threads': message_thread and child threads.
  // SendMessage stays, for the teammate's own sub-agents.
  'ListAgents',
  // Many agents on the member's subscription: sub-agents and child threads.
  'Workflow',
  // Claude's cloud routines and phone notifications, outside Brigade.
  'RemoteTrigger',
  'PushNotification',
  // A thread works on its own branch (checkout_repository).
  'EnterWorktree',
  'ExitWorktree',
  // Claude's own designs and review cards, which Brigade does not show.
  'DesignSync',
  'ReportFindings',
  // Its status line agent, for a terminal Brigade has none of.
  'Agent(statusline-setup)',
]

/**
 * Claude Code's bundled skills that are about Claude Code itself, or that Brigade does
 * otherwise: its schedules (loop, schedule), the CLAUDE.md it writes (init), previews
 * (run), reviews (code-review, which reports with ReportFindings).
 */
const SKILLS_OFF = [
  'loop',
  'schedule',
  'init',
  'run',
  'code-review',
  'workflow-authoring',
  'update-config',
  'keybindings-help',
  'fewer-permission-prompts',
  'plugin-authoring',
]

export const CLAUDE_SETTINGS = {
  // Memory is Brigade's (CLAUDE.md's memory sections); Claude Code's own would be a second one.
  autoMemoryEnabled: false,
  permissions: { deny: DENIED_TOOLS },
  skillOverrides: Object.fromEntries(SKILLS_OFF.map((name) => [name, 'off'])),
}

/** The environment that gives a Claude Code session Brigade's settings. */
export const claudeSettingsEnv = (): Record<string, string> => ({
  BRIGADE_CLAUDE_SETTINGS: JSON.stringify(CLAUDE_SETTINGS),
})
