/**
 * What a side reply (HarnessThread.sideReply) tells the bridges' patches. Both bridges fork the
 * conversation it continues and save none of it (BRIGADE_FORK_SESSION). Claude Code's also lets
 * it read wherever the thread's own turn can (BRIGADE_READS_ANYWHERE): since harness-claude-code
 * 1.0.176 a run that asks before edits asks the host before any read outside its folder too, and
 * a side reply has nobody to ask, so a look at the library or the teammate's skills lost its answer.
 */
export const SIDE_REPLY_ENV = {
  BRIGADE_FORK_SESSION: '1',
  BRIGADE_READS_ANYWHERE: '1',
} as const
