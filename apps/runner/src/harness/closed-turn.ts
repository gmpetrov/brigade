// A Claude Code turn that waits on a person, in a session that stopped since (parked to
// reload its tools, or a runner restart). Continued, the harness reruns it in a new
// process as "Continue.", with the tools it started with: the call it waited on comes back
// interrupted and the answer is lost. So the turn is closed instead, and the answer goes
// in a new message, which brings the session's current tools.

/** A call the closed turn waited on, as EventMapper keeps it. */
export type WaitingCall = { toolCallId: string; toolName: string; input: unknown }

/**
 * The saved session without the turn it waited in, resumed in the same conversation
 * under a new bridge, and the calls that turn waited on. Undefined when it was not
 * waiting on a person (a turn frozen mid-run goes on as it was).
 */
export function closeTurn(
  resume: unknown,
): { resume: unknown; waiting: WaitingCall[] } | undefined {
  const from = (resume as { continueFrom?: Record<string, unknown> } | undefined)?.continueFrom
  const data = from?.data as { claudeSessionId?: unknown; bridge?: unknown } | undefined
  const pending = from?.pendingToolResults
  if (!from || !Array.isArray(pending) || pending.length === 0) return
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
