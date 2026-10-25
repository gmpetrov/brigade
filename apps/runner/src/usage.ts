// What harness runs outside a teammate's turn spend (memory, titles, a project's brief, images),
// told to the API as usage.run: a turn's own usage goes with the thread's events.
import type { AgentEvent, RunnerToApi, UsageRunKind } from '@brigade/contracts'

type UsageRun = Extract<RunnerToApi, { type: 'usage.run' }>

let send: ((message: UsageRun) => void) | undefined

/** Where usage.run goes: the connection to the API, once there is one. */
export function sendUsageRunsTo(sink: (message: UsageRun) => void) {
  send = sink
}

/**
 * Report a run's usage event, if it counted tokens: a limits-only usage.updated
 * (Claude's rate_limit_event) says nothing of what the run spent.
 */
export function reportRunUsage(
  event: AgentEvent,
  run: { kind: UsageRunKind; accountId: string; sessionId?: string; teammateId?: string },
) {
  if (event.type !== 'usage.updated') return
  if (event.inputTokens === undefined && event.outputTokens === undefined) return
  const {
    type: _type,
    at,
    status: _status,
    limits: _limits,
    accountId: _account,
    teammateId: _teammate,
    ...counts
  } = event
  send?.({ type: 'usage.run', at, ...run, ...counts })
}
