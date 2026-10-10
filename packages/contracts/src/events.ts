// AgentEvent: Brigade's own event union. The runner maps harness stream parts
// to these; nothing outside the runner sees a harness type.
import { z } from 'zod'

const base = {
  /** ISO time the event happened on the computer. */
  at: z.iso.datetime(),
  /** The teammate whose harness produced it, in a thread with several. Unset: a person or the runner. */
  teammateId: z.string().optional(),
}

/** A question the harness asks a person (its own question tool). */
export const Question = z.object({
  id: z.string(),
  question: z.string(),
  header: z.string().optional(),
  options: z
    .array(z.object({ id: z.string(), label: z.string(), description: z.string().optional() }))
    .optional(),
  allowMultiple: z.boolean().optional(),
  /** { secret: true }: the harness asks for a secret. Brigade never passes one on. */
  allowFreeForm: z.union([z.boolean(), z.object({ secret: z.boolean() })]).optional(),
})
export type Question = z.infer<typeof Question>

export const QuestionAnswer = z.discriminatedUnion('action', [
  z.object({
    action: z.enum(['answered', 'partially-answered']),
    answers: z.record(
      z.string(),
      z.object({
        optionIds: z.array(z.string()).max(50),
        freeform: z.string().max(20_000).optional(),
      }),
    ),
  }),
  z.object({ action: z.literal('declined') }),
])
export type QuestionAnswer = z.infer<typeof QuestionAnswer>

/**
 * One thing a teammate needs from a person, in a ticket it opens itself
 * (open_ticket). A ticket holds one or more asks; the teammate waits until
 * every one is answered.
 */
export const Ask = z.discriminatedUnion('type', [
  /** Sign-off on a draft or a plan. */
  z.object({
    id: z.string(),
    type: z.literal('approval'),
    title: z.string(),
    draft: z.string().max(50_000),
  }),
  /** A choice: one of the options, or approve / decline when there are none. */
  z.object({
    id: z.string(),
    type: z.literal('decision'),
    question: z.string(),
    options: z
      .array(z.object({ id: z.string(), label: z.string(), description: z.string().optional() }))
      .max(10)
      .optional(),
  }),
  /** A connection or a credential the teammate lacks. */
  z.object({
    id: z.string(),
    type: z.literal('access'),
    kind: z.enum(['connection', 'credential']),
    what: z.string(),
    reason: z.string().optional(),
  }),
  /** Something only a person can do, such as a phone call. */
  z.object({
    id: z.string(),
    type: z.literal('action'),
    title: z.string(),
    steps: z.array(z.string()).max(30).optional(),
  }),
  /** Information. secret: a credential, picked from the vault by mention. */
  z.object({
    id: z.string(),
    type: z.literal('input'),
    question: z.string(),
    secret: z.boolean().optional(),
  }),
])
export type Ask = z.infer<typeof Ask>

/** A person's reply to one ask. */
export const AskReply = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('approval'),
    approved: z.boolean(),
    /** What to change, when not approved. */
    changes: z.string().max(20_000).optional(),
    /** The teammate the changes go to, when not the one that asked. */
    sendTo: z.string().optional(),
  }),
  /** optionId: one of the ask's options, or approve / decline when it has none. */
  z.object({ type: z.literal('decision'), optionId: z.string() }),
  z.object({ type: z.literal('access'), granted: z.boolean() }),
  z.object({
    type: z.literal('action'),
    done: z.boolean(),
    note: z.string().max(20_000).optional(),
  }),
  z.object({ type: z.literal('input'), text: z.string().max(20_000) }),
])
export type AskReply = z.infer<typeof AskReply>

export const TicketAnswer = z.discriminatedUnion('action', [
  z.object({ action: z.literal('answered'), replies: z.record(z.string(), AskReply) }),
  z.object({ action: z.literal('declined') }),
])
export type TicketAnswer = z.infer<typeof TicketAnswer>

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
    /** Why a person must decide, when it is not the usual approval, e.g. a reached cap. */
    reason: z.string().optional(),
  }),
  z.object({
    ...base,
    type: z.literal('approval.resolved'),
    approvalId: z.string(),
    approved: z.boolean(),
    memberId: z.string().nullable(),
    reason: z.string().optional(),
  }),
  /** The harness asks a person something and waits for the answer. */
  z.object({
    ...base,
    type: z.literal('question.asked'),
    questionId: z.string(),
    questions: z.array(Question),
  }),
  z.object({
    ...base,
    type: z.literal('question.answered'),
    questionId: z.string(),
    answer: QuestionAnswer,
    memberId: z.string().nullable(),
  }),
  /** The teammate opens a ticket for a person and waits until it is answered. */
  z.object({
    ...base,
    type: z.literal('ticket.opened'),
    /** The open_ticket tool call's id. */
    requestId: z.string(),
    title: z.string(),
    asks: z.array(Ask),
  }),
  z.object({
    ...base,
    type: z.literal('ticket.answered'),
    requestId: z.string(),
    answer: TicketAnswer,
    memberId: z.string().nullable(),
  }),
  z.object({
    ...base,
    type: z.literal('plan.updated'),
    items: z.array(
      z.object({ content: z.string(), status: z.enum(['pending', 'in_progress', 'completed']) }),
    ),
  }),
  z.object({ ...base, type: z.literal('file.changed'), path: z.string(), toolName: z.string() }),
  /** A picture the harness made, copied into the teammate's working folder at `path`. */
  z.object({
    ...base,
    type: z.literal('image.generated'),
    path: z.string(),
    toolCallId: z.string(),
    prompt: z.string().optional(),
  }),
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
  /** A teammate starts answering. In a thread with several, they answer one after another. */
  z.object({
    ...base,
    type: z.literal('turn.started'),
    teammateId: z.string(),
    /** The account it runs on; usage and sign-in problems after this belong to it. */
    accountId: z.string(),
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
