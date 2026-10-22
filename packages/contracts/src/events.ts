// AgentEvent: Brigade's own event union. The runner maps harness stream parts
// to these; nothing outside the runner sees a harness type.
import { z } from 'zod'
import { MessageAttachment } from './attachments.js'
import { PROPOSE_TEAM_TOOL } from './chief.js'
import { CredentialKind } from './credentials.js'
import { EnvName, PreviewInfo } from './previews.js'
import { RepositoryName } from './repositories.js'

const base = {
  /** ISO time the event happened on the computer. */
  at: z.iso.datetime(),
  /** The teammate whose harness produced it, in a thread with several. Unset: a person or the runner. */
  teammateId: z.string().optional(),
}

/**
 * The earlier message a member's message answers: where it is in the thread
 * (its event's seq), who wrote it (a teammate, else a person) and its text, clipped.
 */
export const ReplyTo = z.object({
  seq: z.number().int().positive(),
  teammateId: z.string().optional(),
  text: z.string().max(2000),
})
export type ReplyTo = z.infer<typeof ReplyTo>

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

/**
 * Alternatives a teammate offers to pick from (its offer_choices tool), such as
 * designs. It does not pause the turn: a person clicks one and it is sent as
 * their next message, or they write one of their own.
 */
export const OFFER_CHOICES_TOOL = 'offer_choices'
export const Choices = z.object({
  question: z.string(),
  options: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        description: z.string().optional(),
        /** A design saved in the library (`<folder>.design`): shown by its picture, opens beside the thread. */
        design: z.string().optional(),
      }),
    )
    .min(2)
    .max(6),
})
export type Choices = z.infer<typeof Choices>
/**
 * The message a click on a choice sends. A design picked from an options
 * folder has been moved to `picked` by then, and the message says where.
 */
export const choiceMessage = (option: { label: string }, picked?: string) =>
  `Go with ${option.label}` +
  (picked ? `. It is now @[${picked}](design:${picked}); the other options went to the trash.` : '')
/** The option a message picked, if it is a click on one. */
export const pickedChoice = <O extends { label: string }>(options: O[], message: string) =>
  options.find(
    (o) => message === choiceMessage(o) || message.startsWith(`${choiceMessage(o)}. It is now @[`),
  )

/**
 * Replies a teammate writes for the person after proposing a next step (its
 * suggest_replies tool), such as "Send it" or "Build and merge". They show as
 * buttons under its reply until anyone answers; a click sends the reply as is.
 */
export const SUGGEST_REPLIES_TOOL = 'suggest_replies'
/** Text a person can see: not only spaces or zero-width characters. */
export const hasVisibleText = (text: string) => /[^\s\u200b-\u200d\u2060\ufeff]/.test(text)
export const SUGGESTED_REPLY_MAX = 40
/**
 * What a button may do instead of sending its text: Brigade's own action, shown
 * only while it can be done. merge: the pull request opened last in the thread.
 * preview: starts the thread's preview as Preview does, without a turn, while none runs.
 */
export const REPLY_ACTIONS = ['merge', 'preview'] as const
export const SuggestedReplies = z
  .object({
    replies: z.array(z.string().trim().min(1).max(SUGGESTED_REPLY_MAX)).max(3),
    /** Shown before the replies. */
    actions: z
      .array(
        z.object({
          action: z.enum(REPLY_ACTIONS),
          label: z.string().trim().min(1).max(SUGGESTED_REPLY_MAX),
        }),
      )
      .max(1)
      .optional(),
  })
  .refine((r) => r.replies.length + (r.actions?.length ?? 0) > 0)
export type SuggestedReplies = z.infer<typeof SuggestedReplies>

/**
 * A visual a teammate draws in the thread (its show_widget tool): options side
 * by side, a diagram, a chart. Throwaway HTML kept in the thread's history, not
 * the library; picking among options it shows goes through offer_choices.
 */
export const SHOW_WIDGET_TOOL = 'show_widget'
/** The rules a teammate reads before its first widget in a thread. */
export const WIDGET_GUIDE_TOOL = 'widget_guide'
/**
 * Steps that are no work of their own, by bare tool name: the reply written
 * before one still answers the turn. A closing card counts even when it was
 * refused and called again; so do a wake-up and a task closed after the reply.
 */
export const ASIDE_TOOLS: ReadonlySet<string> = new Set([
  'ToolSearch',
  'tool_search',
  'TodoWrite',
  'update_plan',
  SHOW_WIDGET_TOOL,
  WIDGET_GUIDE_TOOL,
  SUGGEST_REPLIES_TOOL,
  OFFER_CHOICES_TOOL,
  PROPOSE_TEAM_TOOL,
  'set_wakeup',
  'cancel_wakeup',
  'complete_task',
])

/** How many characters of a text a person sees: spaces and zero-width ones do not count. */
export const visibleChars = (text: string) =>
  text.replace(/[\s\u200b-\u200d\u2060\ufeff]/g, '').length

/** A turn's entries, in order, as its answer is found among them. */
export type TurnEntry =
  | { kind: 'message'; chars: number }
  /** A step of work: a tool call other than an aside, a file changed. */
  | { kind: 'step' }
  /** Anything else: thinking, an aside, a card, a note. */
  | { kind: 'other' }

/** Text with fewer visible characters is a line, such as one on what a step did; with more, an answer. */
export const LINE_CHARS = 200

/**
 * Which messages answer a turn, by position: those after its last step of work,
 * or its last message when none follows that step. The message before that step
 * answers too when it is no mere line and only a line comes after it: a teammate
 * that wrote its answer, then pushed its branch, adds "Pushed." and nothing more.
 * `first` is the first message after the last step (the last message when none).
 * `steered`: the part of a turn before a message steered into it (or before a report from
 * its background work woke it), which answers only when the teammate was done: a message
 * after its last step. Still at work, none does.
 */
export function turnAnswer(
  entries: TurnEntry[],
  steered = false,
): { first: number; messages: number[] } {
  const chars = (at: number) => {
    const entry = entries[at]
    return entry?.kind === 'message' ? entry.chars : 0
  }
  const done = entries.findLastIndex((e) => e.kind === 'step')
  const after = entries.flatMap((e, at) => (at > done && e.kind === 'message' ? [at] : []))
  if (!after.length && steered) return { first: -1, messages: [] }
  if (!after.length) {
    const last = entries.findLastIndex((e) => e.kind === 'message')
    return { first: last, messages: last < 0 ? [] : [last] }
  }
  const before = entries.findLastIndex((e, at) => at < done && e.kind === 'message')
  const line = after.reduce((n, at) => n + chars(at), 0) < LINE_CHARS
  return {
    first: after[0]!,
    messages: line && before >= 0 && chars(before) >= LINE_CHARS ? [before, ...after] : after,
  }
}

/** Written in one tool call and shown only once it is made, so it stays small. */
export const WIDGET_HTML_MAX = 30_000
export const Widget = z.object({
  title: z.string().min(1).max(120),
  html: z.string().min(1).max(WIDGET_HTML_MAX),
})
export type Widget = z.infer<typeof Widget>
/** The dashboard's theme variables a widget may use; the dashboard passes their values in. */
export const WIDGET_THEME_VARS = [
  '--background',
  '--foreground',
  '--card',
  '--card-foreground',
  '--muted',
  '--muted-foreground',
  '--primary',
  '--primary-foreground',
  '--secondary',
  '--accent',
  '--accent-foreground',
  '--border',
  '--destructive-text',
  '--success',
  '--warning',
  '--chart-1',
  '--chart-2',
  '--chart-3',
  '--chart-4',
  '--chart-5',
  '--radius',
  '--font-sans',
  '--font-mono',
] as const

/**
 * Something else, in place of what the teammate asked: a person's own words, such as
 * "use the Cloudflare App instead". The teammate drops the ask and does what they say.
 */
const DeclineNote = z.string().trim().min(1).max(20_000).optional()

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
  z.object({ action: z.literal('declined'), note: DeclineNote }),
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
    /**
     * A connection: the App and the access the teammate needs. Granting gives it
     * that access to one of the App's accounts, from the ticket.
     */
    app: z
      .object({
        kind: z.string().max(40),
        scope: z.enum(['read', 'read_write']),
        /** kind mcp: the MCP server's URL, which the person adds from the ticket if it is not yet. */
        url: z.string().max(500).optional(),
        /**
         * kind github: the repository (owner/name) the teammate needs. The account given must
         * reach it; the person installs the GitHub app on its owner, or adds it, from the ticket.
         */
        repository: RepositoryName.optional(),
        /** The account the teammate means, as its row shows it (the Gmail address): picked first. */
        account: z.string().max(320).optional(),
        /**
         * The teammate the access is for, by id or name, when not the one asking: one a playbook
         * it installs hands this App to (its developer). Unset: the one asking.
         */
        teammate: z.string().max(100).optional(),
      })
      .refine((app) => !app.repository || app.kind === 'github', {
        message: 'repository is for kind github',
        path: ['repository'],
      })
      .optional(),
    /**
     * A credential: what the teammate knows of it, so a person can save it to
     * the vault from the ticket. Only fills in the form; never a secret.
     */
    credential: z
      .object({
        kind: CredentialKind.optional(),
        name: z.string().max(80).optional(),
        url: z.string().max(2000).optional(),
        username: z.string().max(500).optional(),
      })
      .optional(),
  }),
  /** Something only a person can do, such as a phone call. */
  z.object({
    id: z.string(),
    type: z.literal('action'),
    title: z.string(),
    steps: z.array(z.string()).max(30).optional(),
    /**
     * Done in the teammate's browser on the workspace computer, e.g. a "verify
     * you are human" check: the ticket lets the person take over to do it.
     */
    browser: z.boolean().optional(),
  }),
  /** Information. secret: a credential, picked from the vault by mention. */
  z.object({
    id: z.string(),
    type: z.literal('input'),
    question: z.string(),
    secret: z.boolean().optional(),
  }),
  /**
   * Values a repository's preview needs that only a person has, such as a
   * third-party API key. The person sets them as the preview's variables;
   * the teammate learns which were set, never their values.
   */
  z.object({
    id: z.string(),
    type: z.literal('variables'),
    repository: z.string().max(200),
    variables: z
      .array(
        z.object({
          name: EnvName.max(100),
          description: z.string().max(500).optional(),
          /** Unset: a secret. false: a setting, its value shown. */
          secret: z.boolean().optional(),
        }),
      )
      .min(1)
      .max(20),
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
  z.object({
    type: z.literal('access'),
    granted: z.boolean(),
    /** An App's account to grant, when it has several the person may give. */
    connectionId: z.string().max(100).optional(),
    /** A credential granted from the vault, as its mention: the teammate may use it in this thread. */
    credential: z.string().max(1000).optional(),
  }),
  z.object({
    type: z.literal('action'),
    done: z.boolean(),
    note: z.string().max(20_000).optional(),
  }),
  z.object({ type: z.literal('input'), text: z.string().max(20_000) }),
  /** The variables set (their values saved for the preview first), and those skipped. Names only. */
  z.object({
    type: z.literal('variables'),
    set: z.array(z.string().max(100)).max(20),
    skipped: z.array(z.string().max(100)).max(20),
  }),
])
export type AskReply = z.infer<typeof AskReply>

export const TicketAnswer = z.discriminatedUnion('action', [
  z.object({ action: z.literal('answered'), replies: z.record(z.string(), AskReply) }),
  z.object({ action: z.literal('declined'), note: DeclineNote }),
])
export type TicketAnswer = z.infer<typeof TicketAnswer>

/**
 * What a stored event has where its teammate's tool returned an image or a PDF in
 * base64 (a picture it read, a page it captured, a PDF it read): this, then the
 * file's name in its thread, `<sha256>.<ext>`. The file itself is in the bucket,
 * served at /api/threads/:id/files/:name.
 */
export const STORED_FILE = 'brigade-file:'
/** A stored file's name: its SHA-256 and an extension for its type. */
export const STORED_FILE_NAME = /^[0-9a-f]{64}\.(?:png|jpg|gif|webp|pdf)$/

export const AgentEvent = z.discriminatedUnion('type', [
  /**
   * A human prompt sent to the thread, where the teammate reads it: when its
   * turn starts, or in the running turn when steered.
   */
  z.object({
    ...base,
    type: z.literal('message.user'),
    text: z.string(),
    memberId: z.string().nullable(),
    /** The files that came with it. */
    attachments: z.array(MessageAttachment).optional(),
    /** The id the sender gave it; set when it was queued first (message.queued). */
    messageId: z.string().optional(),
    /** Given to the teammate during its running turn rather than in a turn of its own. */
    steered: z.boolean().optional(),
    /** The earlier message it replies to. */
    replyTo: ReplyTo.optional(),
  }),
  /**
   * A message waits for the turn before it to end, or for a person to answer
   * what the teammate asked. Sent again when it is edited or its wait changes.
   */
  z.object({
    ...base,
    type: z.literal('message.queued'),
    messageId: z.string(),
    text: z.string(),
    memberId: z.string().nullable(),
    attachments: z.array(MessageAttachment).optional(),
    replyTo: ReplyTo.optional(),
    /** turn: another turn runs first. person: an approval, question or ticket is answered first. */
    waitingFor: z.enum(['turn', 'person']),
    /** Why a request on it did not happen, e.g. it could not be steered. */
    note: z.string().optional(),
  }),
  /** A queued message will not run: its sender cancelled it, or it was lost. */
  z.object({
    ...base,
    type: z.literal('message.cancelled'),
    messageId: z.string(),
    memberId: z.string().nullable(),
    /** Set when nobody cancelled it, e.g. a person took over or the computer restarted. */
    reason: z.string().optional(),
  }),
  z.object({ ...base, type: z.literal('message.delta'), id: z.string(), text: z.string() }),
  z.object({ ...base, type: z.literal('message.done'), id: z.string(), text: z.string() }),
  /**
   * The images a finished message shows (`![…](path)` or a link to one), read from
   * the computer as it was sent, so the thread shows them once the file has gone or
   * the computer is off. By the path as the message writes it (`relativeFile`): a
   * data: URL from the runner, STORED_FILE and the file's name once stored.
   */
  z.object({
    ...base,
    type: z.literal('message.images'),
    id: z.string(),
    images: z.record(z.string(), z.string()),
  }),
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
    /** The person may also allow it for good: a credential's grant, without asking. */
    always: z.boolean().optional(),
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
    /** The account the limits are for, when read after its turn (Codex) rather than during it. */
    accountId: z.string().optional(),
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
    /** Names this turn, so an interrupt stops it and not the one after it. */
    turnId: z.string().optional(),
  }),
  z.object({ ...base, type: z.literal('turn.completed'), finishReason: z.string() }),
  /**
   * What the person who wrote last may write next, guessed by the teammate's harness once its
   * turn was answered (ThreadSpec.suggestions). It waits in their message box until someone
   * writes or another turn starts (suggestionFor).
   */
  z.object({ ...base, type: z.literal('message.suggested'), text: z.string().max(500) }),
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
  /** A thread's live preview started, answers, failed or stopped. The latest one is its state. */
  z.object({ ...base, type: z.literal('preview.changed'), ...PreviewInfo.shape }),
  /**
   * The repositories checked out in a teammate's folder of the thread ("owner/name"),
   * after a turn that changed them. The latest one per teammate is what the thread
   * has: something a preview can be made of.
   */
  z.object({
    ...base,
    type: z.literal('repositories.changed'),
    repositories: z.array(z.string().max(200)).max(50),
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
