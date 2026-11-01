// What a teammate's turn runs in the background (Claude Code's tasks: sub-agents, shells,
// Monitors), read from the harness's events. The thread shows it and keeps running while any
// runs (the bridge holds the turn open), a failed turn's next try is told what stopped with it,
// and a child's report waits until its own sub-agents are done.
import type { AgentEvent, BackgroundWork } from '@brigade/contracts'

/** Claude Code's task types that are agents at work, and those that are commands (a shell, a Monitor). */
const AGENT_TASKS = new Set(['local_agent', 'remote_agent', 'local_workflow'])
const COMMAND_TASKS = new Set(['local_bash', 'monitor_mcp'])

/** What runs in the background after one of Claude Code's task messages, from a harness event. */
export function backgroundTasks(event: AgentEvent): BackgroundWork[] | undefined {
  if (event.type !== 'raw' || event.source !== 'harness') return
  const value = event.value as {
    type?: unknown
    subtype?: unknown
    tasks?: { task_type?: unknown; description?: unknown; ambient?: unknown }[]
  } | null
  if (value?.type !== 'system' || value.subtype !== 'background_tasks_changed') return
  if (!Array.isArray(value.tasks)) return
  return value.tasks.flatMap((task) => {
    const type = String(task.task_type)
    if (task.ambient || !(AGENT_TASKS.has(type) || COMMAND_TASKS.has(type))) return []
    return [
      {
        kind: AGENT_TASKS.has(type) ? ('agent' as const) : ('command' as const),
        description: String(task.description ?? '').slice(0, 500),
      },
    ]
  })
}

/**
 * Why a child's report is not sent now, or undefined when it can be. It goes to its parent as
 * the whole result: made while the teammate's own sub-agents are still at work, it would leave
 * out what they find, and the parent would take it as final. Their results wake the teammate,
 * which reports then. Background commands (a dev server, a Monitor) do not hold it.
 */
export function reportWaitsFor(background: BackgroundWork[]): string | undefined {
  const agents = background.filter((work) => work.kind === 'agent')
  if (agents.length === 0) return
  const who =
    agents.length === 1 ? 'a sub-agent of yours is' : `${agents.length} sub-agents of yours are`
  return (
    `Not sent: ${who} still at work (${agents.map((work) => work.description).join('; ')}). ` +
    'Their results wake you here when they finish: end your turn now, and call report once you ' +
    'have them all, with the whole result.'
  )
}
