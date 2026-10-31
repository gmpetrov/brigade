// What Brigade turns off in Claude Code. Claude Code ships its own ways of doing
// what Brigade does (schedules, memory, other sessions, cloud routines),
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
  // Claude's own design sync, which Brigade does not show (designs are library files).
  'DesignSync',
  // Its status line agent, for a terminal Brigade has none of.
  'Agent(statusline-setup)',
]

// Its bundled skills stay: Claude Code turns a skill off by its name, whatever it comes from,
// so turning one off would also turn off a skill of the same name a member or a repository
// has. Those that do what Brigade does (loop, schedule) find their tools turned off above.

export const CLAUDE_SETTINGS = {
  // Memory is Brigade's (CLAUDE.md's memory sections); Claude Code's own would be a second one.
  autoMemoryEnabled: false,
  permissions: { deny: DENIED_TOOLS },
}

/** The environment that gives a Claude Code session Brigade's settings. */
export const claudeSettingsEnv = (): Record<string, string> => ({
  BRIGADE_CLAUDE_SETTINGS: JSON.stringify(CLAUDE_SETTINGS),
})
