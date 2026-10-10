// Maps AI SDK harness stream parts to Brigade's AgentEvent. Nothing outside
// this module sees an AI SDK type.
import {
  Ask,
  Question,
  type AgentEvent,
  type QuestionAnswer,
  type TicketAnswer,
} from '@brigade/contracts'
import { ASK_USER_TOOL, OPEN_TICKET_TOOL } from './tools.js'

/** The AI SDK's name for a harness's built-in question tool. */
export const QUESTION_TOOL = 'askUserQuestions'

type AskUserInput = {
  id?: string
  question?: string
  header?: string
  options?: { id?: string; label?: string; description?: string }[]
  allowMultiple?: boolean
  allowFreeForm?: boolean
  secret?: boolean
}

/** Brigade's ask_user input as questions; ids filled in where the model left them out. */
export function askUserQuestions(input: unknown): Question[] | undefined {
  const raw = (input as { questions?: AskUserInput[] } | undefined)?.questions
  if (!Array.isArray(raw)) return undefined
  const parsed = Question.array().safeParse(
    raw.map((q, i) => ({
      id: q.id || `q${i + 1}`,
      question: q.question,
      ...(q.header ? { header: q.header } : {}),
      ...(q.options?.length
        ? {
            options: q.options.map((o, j) => ({
              id: o.id || `o${j + 1}`,
              label: o.label,
              ...(o.description ? { description: o.description } : {}),
            })),
          }
        : {}),
      ...(q.allowMultiple ? { allowMultiple: true } : {}),
      ...(q.secret
        ? { allowFreeForm: { secret: true } }
        : q.allowFreeForm
          ? { allowFreeForm: true }
          : {}),
    })),
  )
  return parsed.success ? parsed.data : undefined
}

/** A person's answer to ask_user, in words the model reads: labels, not option ids. */
export function askUserResult(questions: Question[], answer: QuestionAnswer) {
  if (answer.action === 'declined')
    return {
      declined: true,
      note: 'The person declined to answer. Do not ask again; carry on or stop.',
    }
  return {
    answers: questions.flatMap((q) => {
      const a = answer.answers[q.id]
      if (!a) return []
      const labels = new Map(q.options?.map((o) => [o.id, o.label]) ?? [])
      return [
        {
          question: q.question,
          ...(a.optionIds.length
            ? { selected: a.optionIds.map((id) => labels.get(id) ?? id) }
            : {}),
          ...(a.freeform ? { answer: a.freeform } : {}),
        },
      ]
    }),
  }
}

/** open_ticket's input as a ticket; ids filled in where the model left them out. */
export function ticketAsks(input: unknown): { title: string; asks: Ask[] } | undefined {
  const raw = input as { title?: string; asks?: Record<string, unknown>[] } | undefined
  if (!Array.isArray(raw?.asks)) return undefined
  const asks = Ask.array().safeParse(
    raw.asks.map((a, i) => ({
      ...a,
      id: a.id || `a${i + 1}`,
      ...(Array.isArray(a.options)
        ? {
            options: (a.options as { id?: string }[]).map((o, j) => ({
              ...o,
              id: o.id || `o${j + 1}`,
            })),
          }
        : {}),
    })),
  )
  if (!asks.success || asks.data.length === 0) return undefined
  return { title: raw.title || 'A ticket', asks: asks.data }
}

/** A person's answer to open_ticket, in words the model reads. */
export function ticketResult(asks: Ask[], answer: TicketAnswer) {
  if (answer.action === 'declined')
    return {
      declined: true,
      note: 'The person declined the ticket. Do not do what it asked about; carry on without it or stop.',
    }
  return {
    replies: asks.flatMap((ask): Record<string, unknown>[] => {
      const reply = answer.replies[ask.id]
      if (!reply) return []
      if (ask.type === 'approval' && reply.type === 'approval') {
        if (reply.approved) return [{ ask: ask.title, approved: true }]
        return [
          {
            ask: ask.title,
            approved: false,
            changes: reply.changes ?? '',
            ...(reply.sendTo
              ? {
                  note: 'The person sent these changes to another teammate in this thread. Leave them to it.',
                }
              : {}),
          },
        ]
      }
      if (ask.type === 'decision' && reply.type === 'decision') {
        if (!ask.options) return [{ ask: ask.question, approved: reply.optionId === 'approve' }]
        const label = ask.options.find((o) => o.id === reply.optionId)?.label
        return [{ ask: ask.question, chose: label ?? reply.optionId }]
      }
      if (ask.type === 'access' && reply.type === 'access')
        return [{ ask: `Access to ${ask.what}`, granted: reply.granted }]
      if (ask.type === 'action' && reply.type === 'action')
        return [{ ask: ask.title, done: reply.done, ...(reply.note ? { note: reply.note } : {}) }]
      if (ask.type === 'input' && reply.type === 'input')
        return [{ ask: ask.question, answer: reply.text }]
      return []
    }),
  }
}

const FILE_TOOLS = new Set([
  'write',
  'edit',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'fileChange',
])
const PLAN_TOOLS = new Set(['TodoWrite', 'todoWrite', 'update_plan'])
/** Low-level echoes of the model stream; their content already arrives as mapped parts. */
const DROPPED_RAW = new Set(['stream_event'])

type Part = { type: string; [key: string]: any }

export class EventMapper {
  private texts = new Map<string, string>()
  private reasoning = new Map<string, string>()
  finishReason = 'unknown'
  /** The first error the harness reported during this turn. */
  error: string | undefined
  /** Set when the account ran out of usage during this turn. */
  exhausted: { resetsAt: string | null } | undefined
  /** Calls of a pausing tool (open_ticket) with input nobody could answer. */
  rejected: { toolCallId: string; toolName: string; error: string }[] = []

  /** Recognise an out-of-usage error from either harness. */
  static exhaustedBy(message: string): { resetsAt: string | null } | undefined {
    if (
      !/usage limit|limit reached|hit your (usage )?limit|out of (usage|credits)|quota exceeded|rate_limit_error|too many requests/i.test(
        message,
      )
    )
      return
    const epoch = message.match(/\|(\d{10})\b/)?.[1]
    return { resetsAt: epoch ? new Date(Number(epoch) * 1000).toISOString() : null }
  }

  constructor(
    private readonly emit: (event: AgentEvent) => void,
    /**
     * Tool calls seen so far in the thread. Shared across turns: a call that
     * waited for approval finishes in the next turn, which needs its input.
     */
    private readonly toolCalls = new Map<string, { toolName: string; input: unknown }>(),
  ) {}

  map(part: Part) {
    const at = new Date().toISOString()
    switch (part.type) {
      case 'text-delta': {
        this.texts.set(part.id, (this.texts.get(part.id) ?? '') + part.text)
        return this.emit({ at, type: 'message.delta', id: part.id, text: part.text })
      }
      case 'text-end': {
        const text = this.texts.get(part.id) ?? ''
        this.texts.delete(part.id)
        return this.emit({ at, type: 'message.done', id: part.id, text })
      }
      case 'reasoning-delta':
        return void this.reasoning.set(part.id, (this.reasoning.get(part.id) ?? '') + part.text)
      case 'reasoning-end': {
        const text = this.reasoning.get(part.id)
        this.reasoning.delete(part.id)
        if (text) this.emit({ at, type: 'raw', source: 'reasoning', value: text })
        return
      }
      case 'tool-call': {
        if (this.toolCalls.has(part.toolCallId)) return // adapters may repeat a call around approvals
        this.toolCalls.set(part.toolCallId, { toolName: part.toolName, input: part.input })
        // The harness's own question tool: a person answers, then the turn continues.
        if (part.toolName === QUESTION_TOOL || part.toolName === ASK_USER_TOOL) {
          const questions =
            part.toolName === ASK_USER_TOOL
              ? askUserQuestions(part.input)
              : Question.array().safeParse(part.input?.questions).data
          if (questions)
            return this.emit({
              at,
              type: 'question.asked',
              questionId: part.toolCallId,
              questions,
            })
        }
        // Brigade's ticket tool: a person answers every ask, then the turn continues.
        if (part.toolName === OPEN_TICKET_TOOL) {
          const ticket = ticketAsks(part.input)
          if (ticket)
            return this.emit({
              at,
              type: 'ticket.opened',
              requestId: part.toolCallId,
              title: ticket.title,
              asks: ticket.asks,
            })
          // Nobody could answer it: the turn gets the error back instead of waiting.
          this.rejected.push({
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            error:
              'Invalid ticket: give a title and 1 to 6 asks, each with the fields its type needs ' +
              '(approval: title, draft; decision: question; access: kind, what; action: title; input: question).',
          })
        }
        this.emit({
          at,
          type: 'tool.started',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
        })
        if (PLAN_TOOLS.has(part.toolName) && Array.isArray(part.input?.todos)) {
          this.emit({
            at,
            type: 'plan.updated',
            items: part.input.todos.map((t: { content?: string; status?: string }) => ({
              content: String(t.content ?? ''),
              status: t.status === 'completed' || t.status === 'in_progress' ? t.status : 'pending',
            })),
          })
        }
        return
      }
      case 'tool-approval-request':
        return this.emit({
          at,
          type: 'approval.requested',
          approvalId: part.approvalId,
          toolCallId: part.toolCall.toolCallId,
          toolName: part.toolCall.toolName,
          input: part.toolCall.input,
        })
      case 'tool-result': {
        const call = this.toolCalls.get(part.toolCallId)
        this.toolCalls.delete(part.toolCallId)
        this.emit({
          at,
          type: 'tool.finished',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output: part.output,
          isError: false,
        })
        const path = call?.input as
          { file_path?: string; notebook_path?: string; path?: string } | undefined
        const file = path?.file_path ?? path?.notebook_path ?? path?.path
        if (FILE_TOOLS.has(part.toolName) && file)
          this.emit({ at, type: 'file.changed', path: file, toolName: part.toolName })
        return
      }
      case 'tool-error':
        this.toolCalls.delete(part.toolCallId)
        return this.emit({
          at,
          type: 'tool.finished',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output: String(part.error?.message ?? part.error),
          isError: true,
        })
      case 'tool-output-denied':
        this.toolCalls.delete(part.toolCallId)
        return this.emit({
          at,
          type: 'tool.finished',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output: 'Denied',
          isError: true,
        })
      case 'finish': {
        this.finishReason = part.finishReason
        const usage = part.totalUsage ?? {}
        if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
          this.emit({
            at,
            type: 'usage.updated',
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
          })
        }
        return
      }
      case 'error': {
        const message = errorMessage(part.error)
        const exhausted = EventMapper.exhaustedBy(message)
        if (exhausted) return void (this.exhausted = exhausted)
        this.error ??= message
        return this.emit({ at, type: 'error', message })
      }
      case 'raw': {
        const value = part.rawValue
        if (DROPPED_RAW.has(value?.type)) return
        if (value?.type === 'rate_limit_event') {
          const info = value.rate_limit_info ?? {}
          const status =
            info.status === 'rejected'
              ? 'rejected'
              : info.status === 'allowed_warning'
                ? 'warning'
                : 'allowed'
          if (status === 'rejected') {
            this.exhausted = {
              resetsAt: info.resetsAt ? new Date(info.resetsAt * 1000).toISOString() : null,
            }
          }
          return this.emit({ at, type: 'usage.updated', status, limits: limits(info) })
        }
        return this.emit({ at, type: 'raw', source: 'harness', value })
      }
      // Stream lifecycle parts carry nothing a person needs to see.
      case 'start':
      case 'start-step':
      case 'finish-step':
      case 'text-start':
      case 'reasoning-start':
      case 'tool-input-start':
      case 'tool-input-delta':
      case 'tool-input-end':
      case 'tool-approval-response': // the runner records who answered when the answer arrives
      case 'abort':
        return
      default:
        return this.emit({ at, type: 'raw', source: part.type, value: part })
    }
  }
}

function limits(
  info:
    { unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }> } | undefined,
) {
  return Object.entries(info?.unifiedWindows ?? {}).map(([window, w]) => ({
    window,
    utilization: w.utilization ?? 0,
    resetsAt: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null,
  }))
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return JSON.stringify(error)
}
