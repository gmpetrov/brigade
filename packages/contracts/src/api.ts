// HTTP payloads and the browser WebSocket protocol.
import { z } from 'zod'
import { AttachmentIds } from './attachments.js'
import { QuestionAnswer, SequencedEvent, TicketAnswer } from './events.js'
import { LibraryAccess } from './library.js'
import { isHarnessModel } from './models.js'
import { CLIPBOARD_MAX, HarnessId } from './runner.js'

export const HealthResponse = z.object({
  status: z.literal('ok'),
  protocolVersion: z.number().int(),
})
export type HealthResponse = z.infer<typeof HealthResponse>

export const CreateWorkspace = z.object({ name: z.string().trim().min(1).max(80) })
export const SwitchWorkspace = z.object({ workspaceId: z.string() })

/** One of HARNESS_MODELS for the teammate's harness, or null for the account's default. */
export const TeammateModel = z.string().trim().max(100).nullable()
export const CreateTeammate = z
  .object({
    name: z.string().trim().min(1).max(80),
    instructions: z.string().max(20_000).default(''),
    harness: HarnessId.default('claude_code'),
    model: TeammateModel.default(null),
  })
  .refine((t) => isHarnessModel(t.harness, t.model), {
    path: ['model'],
    message: 'Not a model this agent can run',
  })
export const PermissionPolicy = z.object({
  /** Connector writes: allow (the default), ask (a ticket waits for a person) or deny. */
  connectorWrites: z.enum(['allow', 'ask', 'deny']).optional(),
})
export type PermissionPolicy = z.infer<typeof PermissionPolicy>
/** Daily caps per teammate. Unset means no cap. Reaching one pauses new work and opens a ticket. */
export const Caps = z.object({
  threadsPerDay: z.number().int().min(0).max(100_000).nullable().optional(),
  computerHoursPerDay: z.number().min(0).max(24).nullable().optional(),
  /** Write calls per connection, counted separately for each connection. */
  writeCallsPerConnectionPerDay: z.number().int().min(0).max(1_000_000).nullable().optional(),
})
export type Caps = z.infer<typeof Caps>
// Not CreateTeammate.partial(): Zod applies defaults inside partial(), which would reset unsent fields.
export const UpdateTeammate = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  instructions: z.string().max(20_000).optional(),
  harness: HarnessId.optional(),
  /** Checked against the teammate's harness by the API, which knows the stored one. */
  model: TeammateModel.optional(),
  permissionPolicy: PermissionPolicy.optional(),
  caps: Caps.optional(),
  libraryAccess: LibraryAccess.optional(),
})
export const SetGrant = z.object({
  connectionId: z.string(),
  scope: z.enum(['none', 'read', 'read_write']),
})
export const ConnectGoogle = z.object({ kind: z.enum(['gmail', 'google_calendar']) })
/** A Stripe secret or restricted key, entered once in the dashboard and kept in the vault. */
export const ConnectStripe = z.object({
  apiKey: z
    .string()
    .trim()
    .regex(/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/, 'A Stripe secret (sk_) or restricted (rk_) key'),
  label: z.string().trim().min(1).max(80).optional(),
})
/** A custom app that posts events to Brigade. No credential: its triggers' URLs carry the trust. */
export const ConnectWebhookApp = z.object({ label: z.string().trim().min(1).max(80) })
/** A trigger from the connection's catalog; a custom app's also says how its sender is verified. */
export const CreateTrigger = z.object({
  connectionId: z.string(),
  teammateId: z.string(),
  label: z.string().trim().min(1).max(80),
  /** The catalog id, e.g. payment_received. A custom app's is "received". */
  event: z.string().max(80),
  /** The catalog's options for it, e.g. { query: "to:support@acme.com" }. */
  options: z.record(z.string(), z.string().trim().max(500)).default({}),
  /** Custom apps only. hmac: X-Brigade-Signature with a secret Brigade generates. none: the URL alone. */
  verification: z.enum(['hmac', 'none']).optional(),
})
export const ResolveTicket = z.object({
  approved: z.boolean(),
  reason: z.string().max(2000).optional(),
})

const hasContent = (m: { text: string; attachmentIds: string[] }) =>
  m.text.length > 0 || m.attachmentIds.length > 0

export const StartThread = z
  .object({
    teammateId: z.string(),
    computerId: z.string(),
    /** Omit to use the member's default account for the teammate's harness. */
    accountId: z.string().optional(),
    text: z.string().trim().max(100_000).default(''),
    /** Files uploaded with POST /attachments, given to the thread with this message. */
    attachmentIds: AttachmentIds,
  })
  .refine(hasContent, { path: ['text'], message: 'Write a message or attach a file' })

export const AddAccount = z.object({
  computerId: z.string(),
  provider: HarnessId,
  label: z.string().trim().max(80).optional(),
})
export const TakeOver = z.object({ interrupt: z.boolean().default(false) })
export const HandBack = z.object({ note: z.string().max(20_000).default('') })
/** With text: put it on the desktop's clipboard. Without: read the clipboard. */
export const DesktopClipboard = z.object({ text: z.string().max(CLIPBOARD_MAX).optional() })
export const SubmitLoginCode = z.object({ code: z.string().trim().min(1).max(4000) })
export const UpdateAccount = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  isDefault: z.literal(true).optional(),
})
export const SendMessage = z
  .object({
    text: z.string().trim().max(100_000).default(''),
    attachmentIds: AttachmentIds,
  })
  .refine(hasContent, { path: ['text'], message: 'Write a message or attach a file' })
export const ResolveApproval = z.object({
  approvalId: z.string(),
  approved: z.boolean(),
  reason: z.string().max(2000).optional(),
})

export const AnswerQuestion = z.object({ questionId: z.string(), answer: QuestionAnswer })
export const AnswerTicket = z.object({ requestId: z.string(), answer: TicketAnswer })
export const OpenBrowser = z.object({ url: z.url({ protocol: /^https?$/ }).optional() })

export const RunnerLink = z.object({
  code: z.string().trim().min(1),
  name: z.string().trim().min(1).max(120),
  platform: z.string().max(60),
  version: z.string().max(40),
})
export const RunnerLinkResult = z.object({
  token: z.string(),
  computerId: z.string(),
  workspaceName: z.string(),
})
export type RunnerLinkResult = z.infer<typeof RunnerLinkResult>

// Browser <-> API WebSocket
export const BrowserToApi = z.discriminatedUnion('type', [
  /** Follow a thread. The API replays stored events after `afterSeq`, then streams live ones. */
  z.object({
    type: z.literal('subscribe'),
    sessionId: z.string(),
    afterSeq: z.number().int().min(0),
  }),
  z.object({ type: z.literal('unsubscribe'), sessionId: z.string() }),
  /** Takeover terminal on a thread's computer. Only while the member holds control of the thread. */
  z.object({
    type: z.literal('terminal.open'),
    terminalId: z.string().uuid(),
    sessionId: z.string(),
    cols: z.number().int().min(20).max(400),
    rows: z.number().int().min(5).max(200),
  }),
  z.object({
    type: z.literal('terminal.input'),
    terminalId: z.string(),
    data: z.string().max(65_536),
  }),
  z.object({ type: z.literal('terminal.close'), terminalId: z.string() }),
])
export type BrowserToApi = z.infer<typeof BrowserToApi>

export const ApiToBrowser = z.discriminatedUnion('type', [
  z.object({ type: z.literal('events'), events: z.array(SequencedEvent) }),
  z.object({
    type: z.literal('thread.updated'),
    sessionId: z.string(),
    status: z.string(),
  }),
  z.object({ type: z.literal('computer.updated'), computerId: z.string(), online: z.boolean() }),
  /** A task was created, changed or removed: refetch the board. */
  z.object({ type: z.literal('task.updated'), taskId: z.string() }),
  /** A schedule was created, changed, fired or removed: refetch the list. */
  z.object({ type: z.literal('schedule.updated'), scheduleId: z.string() }),
  z.object({ type: z.literal('terminal.output'), terminalId: z.string(), data: z.string() }),
  z.object({
    type: z.literal('terminal.exit'),
    terminalId: z.string(),
    code: z.number().int().nullable(),
  }),
  /** Sign-in progress, sent only to the member who owns the account. */
  z.object({
    type: z.literal('account.login'),
    accountId: z.string(),
    state: z.enum(['starting', 'open_url', 'verifying', 'done', 'failed']),
    url: z.string().optional(),
    userCode: z.string().optional(),
    flow: z.enum(['paste', 'device']).optional(),
    error: z.string().optional(),
  }),
  z.object({ type: z.literal('error'), message: z.string() }),
])
export type ApiToBrowser = z.infer<typeof ApiToBrowser>
