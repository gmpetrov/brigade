// AgentEvent: Brigade's own event union. The runner maps harness stream parts
// to these; nothing outside the runner sees a harness type.
import { z } from 'zod'

const base = {
  /** ISO time the event happened on the computer. */
  at: z.iso.datetime(),
}

export const AgentEvent = z.discriminatedUnion('type', [
  /** A human prompt sent to the thread. */
  z.object({
    ...base,
    type: z.literal('message.user'),
    text: z.string(),
    memberId: z.string().nullable(),
  }),
  z.object({ ...base, type: z.literal('message.delta'), id: z.string(), text: z.string() }),
  z.object({ ...base, type: z.literal('message.done'), id: z.string(), text: z.string() }),
  z.object({
    ...base,
    type: z.literal('tool.started'),
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.unknown(),
  }),
  z.object({
    ...base,
    type: z.literal('tool.finished'),
    toolCallId: z.string(),
    toolName: z.string(),
    output: z.unknown(),
    isError: z.boolean(),
  }),
  z.object({
    ...base,
    type: z.literal('approval.requested'),
    approvalId: z.string(),
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.unknown(),
  }),
  z.object({
    ...base,
    type: z.literal('approval.resolved'),
    approvalId: z.string(),
    approved: z.boolean(),
    memberId: z.string().nullable(),
    reason: z.string().optional(),
  }),
  z.object({
    ...base,
    type: z.literal('plan.updated'),
    items: z.array(
      z.object({ content: z.string(), status: z.enum(['pending', 'in_progress', 'completed']) }),
    ),
  }),
  z.object({ ...base, type: z.literal('file.changed'), path: z.string(), toolName: z.string() }),
  z.object({
    ...base,
    type: z.literal('usage.updated'),
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    /** allowed, warning (close to a limit) or rejected (out of usage). */
    status: z.enum(['allowed', 'warning', 'rejected']).optional(),
    /** Subscription limits where the harness exposes them. utilization is 0..1. */
    limits: z
      .array(
        z.object({
          window: z.string(),
          utilization: z.number(),
          resetsAt: z.iso.datetime().nullable(),
        }),
      )
      .optional(),
  }),
  z.object({
    ...base,
    type: z.literal('control.changed'),
    controller: z.enum(['teammate', 'human']),
    memberId: z.string().nullable(),
  }),
  z.object({ ...base, type: z.literal('turn.completed'), finishReason: z.string() }),
  /** A command a person ran in the computer's terminal during takeover. */
  z.object({
    ...base,
    type: z.literal('terminal.command'),
    command: z.string(),
    memberId: z.string(),
  }),
  /**
   * The thread moved to another account of the same member, or paused
   * (toAccountId null) because none has usage left.
   */
  z.object({
    ...base,
    type: z.literal('account.switched'),
    fromAccountId: z.string(),
    toAccountId: z.string().nullable(),
    reason: z.enum(['usage_limit', 'unavailable']),
    resetsAt: z.iso.datetime().nullable(),
  }),
  z.object({ ...base, type: z.literal('error'), message: z.string() }),
  z.object({ ...base, type: z.literal('raw'), source: z.string(), value: z.unknown() }),
])
export type AgentEvent = z.infer<typeof AgentEvent>
export type AgentEventType = AgentEvent['type']

/** An AgentEvent as stored: with its thread and sequence number. */
export const SequencedEvent = z.object({
  sessionId: z.string(),
  seq: z.number().int().positive(),
  event: AgentEvent,
})
export type SequencedEvent = z.infer<typeof SequencedEvent>
