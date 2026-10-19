// A teammate's task tools may pick a task's project, like the Project select in
// the task panel: a task in a mission takes the mission's project instead.

/**
 * Why a task tool call may not set the project, or null. project: what the call
 * asks (unset: no change). mission: the mission the task is in once the call is done.
 */
export function projectRefusal(project: string | null | undefined, mission: string | null) {
  if (project === undefined || !mission) return null
  return (
    "A task in a mission is in the mission's project: leave project out, move the mission instead, " +
    'or take the task out of its mission (mission "none") to give it a project of its own.'
  )
}
