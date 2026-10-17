// A Claude Code turn that waits on a person, in a session that stopped since (parked to
// reload its tools, or a runner restart). Continued, the harness reruns it in a new
// process as "Continue.", with the tools it started with: the call it waited on comes back
// interrupted and the answer is lost. So the turn is closed instead, and the answer goes
// in a new message, which brings the session's current tools.

/** A call the closed turn waited on, as EventMapper keeps it. */
export type WaitingCall = { toolCallId: string; toolName: string; input: unknown }

/** A built-in tool call the closed turn waited to have approved: it never ran. */
export type WaitingApproval = { approvalId: string; toolName: string; input: unknown }

/**
 * The saved session without the turn it waited in, resumed in the same conversation
 * under a new bridge, and the calls that turn waited on. Undefined when it was not
 * waiting on a person (a turn frozen mid-run goes on as it was).
 */
export function closeTurn(
  resume: unknown,
): { resume: unknown; waiting: WaitingCall[]; approvals: WaitingApproval[] } | undefined {
  const from = (resume as { continueFrom?: Record<string, unknown> } | undefined)?.continueFrom
  const data = from?.data as { claudeSessionId?: unknown; bridge?: unknown } | undefined
  const pending = Array.isArray(from?.pendingToolResults) ? from.pendingToolResults : []
  const approvals = Array.isArray(from?.pendingToolApprovals) ? from.pendingToolApprovals : []
  if (!from || pending.length + approvals.length === 0) return
  // The bridge it ran under stopped with the session. A thread's first turn has no
  // conversation id yet: Claude Code then continues the newest one in the thread's folder.
  const { bridge: _bridge, ...rest } = data ?? {}
  return {
    resume: {
      type: 'resume-session',
      harnessId: from.harnessId,
      specificationVersion: from.specificationVersion,
      data: rest,
    },
    waiting: (pending as { toolCallId?: unknown; toolName?: unknown; input?: unknown }[])
      .filter((p) => typeof p.toolCallId === 'string' && typeof p.toolName === 'string')
      .map((p) => ({
        toolCallId: p.toolCallId as string,
        toolName: p.toolName as string,
        input: parsed(p.input),
      })),
    approvals: (approvals as { approvalId?: unknown; toolName?: unknown; input?: unknown }[])
      .filter((p) => typeof p.approvalId === 'string' && typeof p.toolName === 'string')
      .map((p) => ({
        approvalId: p.approvalId as string,
        toolName: p.toolName as string,
        input: parsed(p.input),
      })),
  }
}

/** The harness keeps a pending call's input as JSON text. */
const parsed = (input: unknown) => {
  if (typeof input !== 'string') return input
  try {
    return JSON.parse(input) as unknown
  } catch {
    return input
  }
}

/** A person's answer to a closed turn's call (closeTurn), as a new message. */
export const answerAfterRestart = (result: { toolName: string; output: { value: unknown } }) =>
  `Your session restarted while you waited on the person, which cut off your ${result.toolName} call above: ` +
  `it shows as interrupted, but they answered it. Their answer:\n\n${JSON.stringify(result.output.value)}\n\n` +
  'Carry on from there, without asking again.'

/** The calls still waiting on a person among those not finished yet (EventMapper's). */
export const waitingOn = (
  calls: ReadonlyMap<string, { toolName: string; input: unknown }>,
  tools: ReadonlySet<string>,
): WaitingCall[] =>
  [...calls]
    .filter(([, call]) => tools.has(call.toolName))
    .map(([toolCallId, call]) => ({ toolCallId, ...call }))

/**
 * A person's decision on a closed turn's approval (closeTurn), as a new message. Approved,
 * the call runs again unchanged without asking twice (sameCall).
 */
export const approvalAfterRestart = (
  call: Pick<WaitingApproval, 'toolName' | 'input'> | undefined,
  approved: boolean,
  reason?: string,
) => {
  const what = call
    ? `your ${call.toolName} call above (${JSON.stringify(call.input)})`
    : 'the call you asked to make above'
  return (
    `Your session restarted while ${what} waited for the person's approval, so it never ran. ` +
    (approved
      ? 'They approved it: make the same call again now, unchanged, then carry on.'
      : `They declined it${reason ? `: ${reason}` : ''}. Do not make it; carry on without it or stop.`)
  )
}

/** The same call, whatever the order of its input's keys or whether it is still JSON text. */
export const sameCall = (
  a: Pick<WaitingApproval, 'toolName' | 'input'>,
  b: Pick<WaitingApproval, 'toolName' | 'input'>,
) =>
  a.toolName.toLowerCase() === b.toolName.toLowerCase() &&
  canonical(parsed(a.input)) === canonical(parsed(b.input))

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(value)
}
