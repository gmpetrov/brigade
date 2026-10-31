// HTTP payloads and the browser WebSocket protocol.
import { z } from 'zod'
import { AttachmentIds } from './attachments.js'
import { AskReply, QuestionAnswer, ReplyTo, SequencedEvent, TicketAnswer } from './events.js'
import { LibraryAccess, LibraryPath } from './library.js'
import { isHarnessModel } from './models.js'
import { Logo } from './projects.js'
import { CLIPBOARD_MAX, Effort, HarnessId } from './runner.js'
import { TriggerInstructions } from './triggers.js'

export const HealthResponse = z.object({
  status: z.literal('ok'),
  protocolVersion: z.number().int(),
  /** The commit it was deployed from, when the deploy says (scripts/deploy/workers.sh). */
  build: z.string().optional(),
})
export type HealthResponse = z.infer<typeof HealthResponse>

export const CreateWorkspace = z.object({ name: z.string().trim().min(1).max(80) })
export const SwitchWorkspace = z.object({ workspaceId: z.string() })
/** To another organization the person belongs to, in its first workspace. */
export const SwitchOrganization = z.object({ organizationId: z.string() })
/** An owner or admin invites an address to the organization (only an owner invites an owner). */
export const CreateInvitation = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(320)),
  role: z.enum(['viewer', 'member', 'admin', 'owner']).default('member'),
})
/** An owner or admin changes a member's role (only an owner makes or unmakes an owner). */
export const UpdateMember = z.object({ role: z.enum(['viewer', 'member', 'admin', 'owner']) })
/** An owner or admin renames the active workspace, or changes its logo (null: back to its letter). */
export const UpdateWorkspace = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  logo: Logo.nullable().optional(),
})

/** An owner deletes the active workspace for good, typing its name to confirm. */
export const DeleteWorkspace = z.object({ name: z.string().max(200) })
/** A person deletes their own account for good, typing their email address to confirm. */
export const DeleteAccount = z.object({ email: z.string().max(320) })

/** Checkout for the Cloud plan, from Settings › Billing or onboarding, where it comes back to. */
export const BillingCheckout = z.object({
  from: z.enum(['billing', 'onboarding']).default('billing'),
})

/**
 * Settings › Billing (GET /api/billing). enabled: billing is on for this server (off on a
 * self-hosted Brigade, where the cloud computer is free). plan: the workspace's Cloud plan,
 * or null before its first subscription.
 */
export type BillingResponse = {
  enabled: boolean
  plan: {
    /** Stripe's status: active, trialing, past_due, canceled, unpaid… */
    status: string
    /** It gives the workspace its cloud computer now. */
    active: boolean
    /** Given by Brigade, with nothing to pay or manage. */
    complimentary: boolean
    /** The end of the period paid for. */
    periodEnd: string | null
    /** When it ends, once canceled. */
    cancelAt: string | null
  } | null
}

/** Where the dashboard reads a workspace's logo, under /api. */
export const workspaceLogoPath = (workspace: { id: string; logo: string }) =>
  `/workspaces/${workspace.id}/logo?v=${encodeURIComponent(workspace.logo)}`

/** One of HARNESS_MODELS for the teammate's harness, or null for the account's default. */
export const TeammateModel = z.string().trim().max(100).nullable()
/** A teammate's role in a few words, shown as a badge beside its name. */
const TeammateTitle = z.string().trim().max(40)
export const CreateTeammate = z
  .object({
    name: z.string().trim().min(1).max(80),
    title: TeammateTitle.default(''),
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
  /**
   * Emails from Brigade's own addresses (the Email App) to anyone outside the workspace: ask
   * (the default, whatever connectorWrites says) or allow. A deny of connectorWrites still stands.
   */
  emailSends: z.enum(['allow', 'ask']).optional(),
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
  title: TeammateTitle.optional(),
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
/** A dashboard page to come back to after the provider's consent, e.g. the thread a Connect button was in. */
export const ReturnTo = z
  .string()
  .max(300)
  .regex(/^\/app\/[\w\-/?=&.%]*$/, 'A dashboard path')
export const ConnectGoogle = z.object({
  kind: z.enum([
    'gmail',
    'google_calendar',
    'google_drive',
    'google_docs',
    'google_sheets',
    'google_search_console',
    'google_analytics',
  ]),
  returnTo: ReturnTo.optional(),
})
export const ConnectGitHub = z.object({ returnTo: ReturnTo.optional() })
/** An App whose account signs in on its MCP server's own OAuth. */
export const ConnectMcp = z.object({
  kind: z.enum([
    'cloudflare',
    'google_cloud',
    'neon',
    'supabase',
    'atlassian',
    'notion',
    'linear',
    'mixpanel',
    'resend',
    'replicate',
    'openrouter',
    'posthog',
    'dataforseo',
    'ahrefs',
    'stripe',
  ]),
  /** For an App with a server per data region (Mixpanel): the region's id. Default: the first. */
  region: z.string().max(20).optional(),
  returnTo: ReturnTo.optional(),
  /** The account being reconnected: Stripe repairs it when its sign-in alone cannot say which. */
  reconnect: z.string().max(100).optional(),
})
/** An MCP server's address, to see what it is and how its accounts sign in. */
export const InspectMcp = z.object({ url: z.string().trim().min(1).max(500) })
/**
 * An account on an MCP server added by its URL: a new App (url, with the name it is
 * shown by) or another account of an App already added (appId). With what its sign-in
 * needs: nothing, a key (in header, default Authorization as a Bearer token), or for a
 * server that registers no OAuth client, the member's own.
 */
export const ConnectMcpServer = z
  .object({
    url: z.string().trim().min(1).max(500).optional(),
    appId: z.string().optional(),
    name: z.string().trim().min(1).max(80).optional(),
    apiKey: z.string().trim().min(1).max(4000).optional(),
    header: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9-]{1,60}$/, 'A header name, e.g. X-API-Key')
      .optional(),
    clientId: z.string().trim().min(1).max(500).optional(),
    clientSecret: z.string().trim().min(1).max(4000).optional(),
    returnTo: ReturnTo.optional(),
  })
  .refine((v) => v.url || v.appId, 'The server URL, or the App to add an account to')
/** What an MCP server is, before anyone signs in (see the API's inspectMcp). */
export type McpInspection = {
  url: string
  transport: 'streamable' | 'sse'
  /** oauth: the provider's sign-in. oauth_client: the same with a client the member registered. */
  signIn: 'oauth' | 'oauth_client' | 'api_key' | 'none'
  name: string
  description: string | null
  icons: string[]
  tools: { name: string; description: string; write: boolean }[] | null
  /** The App this server already is in the workspace, with an account. */
  app: { id: string; name: string } | null
  /** Where the member's own OAuth client must send people back. */
  redirectUri: string
}
/** A custom app that posts events to Brigade. No credential: its triggers' URLs carry the trust. */
export const ConnectWebhookApp = z.object({ label: z.string().trim().min(1).max(80) })
/**
 * An account of an App: its name, and where teammates may use it. mine: only in
 * threads the member who connected it started; workspace: in every thread.
 */
export const UpdateConnection = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  reach: z.enum(['mine', 'workspace']).optional(),
  /** Gmail shared with the workspace: its mail shows in the Inbox (src/inbox.ts). */
  inbox: z.boolean().optional(),
})
/** An App's tools that no teammate gets, on any of its accounts. */
export const UpdateApp = z.object({ disabledTools: z.array(z.string().max(100)).max(200) })
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
  /** The threads it starts are in this project. */
  projectId: z.string().nullish(),
  /** What the teammate does with each event, before the event in each thread. */
  instructions: TriggerInstructions.optional(),
})
/** An email's draft as a person approving it changed it (the Email App's email_send). */
export const EditedEmail = z.object({
  to: z.array(z.string().email()).min(1).max(50),
  cc: z.array(z.string().email()).max(50).optional(),
  subject: z.string().max(500),
  text: z.string().max(100_000),
})
export type EditedEmail = z.infer<typeof EditedEmail>
export const ResolveTicket = z.object({
  approved: z.boolean(),
  reason: z.string().max(2000).optional(),
  /** A credential's ticket: also let the teammate use it from now on, without asking. */
  always: z.boolean().optional(),
  /** An email's approval: the draft as the person changed it before approving. */
  edited: EditedEmail.optional(),
})

const hasContent = (m: { text: string; attachmentIds: string[] }) =>
  m.text.length > 0 || m.attachmentIds.length > 0

/**
 * A new thread's id, chosen by the browser so that it can open the thread before it exists: a
 * cuid's shape (a `c` and 24 lowercase letters or digits), random, as it also names the thread's
 * folders in storage.
 */
export const NewThreadId = z.string().regex(/^c[a-z0-9]{24}$/, 'Not a thread id')

export const StartThread = z
  .object({
    /** Its id, chosen beforehand (NewThreadId): refused when a thread has it already. */
    id: NewThreadId.optional(),
    teammateId: z.string(),
    computerId: z.string(),
    /** Omit to use the member's default account for the teammate's harness. */
    accountId: z.string().optional(),
    text: z.string().trim().max(100_000).default(''),
    /** Files uploaded with POST /attachments, given to the thread with this message. */
    attachmentIds: AttachmentIds,
    /** The project the thread works in. */
    projectId: z.string().nullish(),
    /** How hard its teammates think; omit for the harness's default. */
    effort: Effort.nullish(),
  })
  .refine(hasContent, { path: ['text'], message: 'Write a message or attach a file' })

export const AddAccount = z.object({
  computerId: z.string(),
  provider: HarnessId,
  label: z.string().trim().max(80).optional(),
})
export const TakeOver = z.object({ interrupt: z.boolean().default(false) })
export const HandBack = z.object({
  note: z.string().max(20_000).default(''),
  /** The asks answered so far in the member's browser, by ticket (its requestId) then ask. */
  replies: z.record(z.string().max(200), z.record(z.string().max(200), AskReply)).optional(),
})
/** With text: put it on the desktop's clipboard. Without: read the clipboard. */
export const DesktopClipboard = z.object({ text: z.string().max(CLIPBOARD_MAX).optional() })
/** Teach a task holds the cloud computer: from a thread, which its own count of others leaves out. */
export const TeachRecording = z.object({ threadId: z.string().optional() })
/** Who records on the cloud computer and how many threads run there, for Teach a task. */
export type TeachState = { recordingBy: string | null; running: number }
export const SubmitLoginCode = z.object({
  code: z.string().trim().min(1).max(4000),
  /** The account's email, as the member gives it, for a sign-in that cannot tell (a Claude token). */
  email: z.string().trim().max(254).pipe(z.email()).optional(),
})
export const UpdateAccount = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  isDefault: z.literal(true).optional(),
  /** Usable again before the reset Brigade noted, as the member says (usage reset or bought). */
  exhaustedUntil: z.null().optional(),
})
export const SendMessage = z
  .object({
    text: z.string().trim().max(100_000).default(''),
    attachmentIds: AttachmentIds,
    /** The sender's id for it, so it can be shown as queued at once and found again. */
    messageId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/)
      .optional(),
    /** Give it to the teammate during its running turn instead of queuing it. */
    steer: z.boolean().optional(),
    /**
     * A design the thread offered in an options folder, picked by this message:
     * it becomes the design and the other options go to the trash.
     */
    pick: LibraryPath.optional(),
    /** The earlier message in the thread this one replies to, quoted for the teammate. */
    replyTo: ReplyTo.optional(),
    /** Continue the thread on this computer: it moves there first, and this message goes with it. */
    moveTo: z.string().min(1).max(64).optional(),
  })
  .refine(hasContent, { path: ['text'], message: 'Write a message or attach a file' })
/** Change a thread: its effort from the next turn on (null: the default); who may prompt and private, by its starter only. */
export const UpdateThread = z.object({
  effort: Effort.nullable().optional(),
  othersMayPrompt: z.boolean().optional(),
  private: z.boolean().optional(),
})
/** Continue a thread on another computer without a message: its teammate picks up where it was. */
export const MoveThread = z.object({ computerId: z.string().min(1).max(64) })
/**
 * Cancel a queued message, change its text, or steer it into the running turn. parallel:
 * steer it with the ask to hand it to a child thread at once (inParallel).
 */
export const QueuedMessageAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('cancel') }),
  z.object({ action: z.literal('steer') }),
  z.object({ action: z.literal('parallel') }),
  z.object({ action: z.literal('edit'), text: z.string().trim().min(1).max(100_000) }),
])
export type QueuedMessageAction = z.infer<typeof QueuedMessageAction>

/**
 * What a person may do with a queued message (memberId: who wrote it): steer any into the
 * running turn, but edit, cancel or send to run in parallel only one a person wrote. One nobody typed (a child's
 * report, a wake-up, a teammate's comment) is what the teammate is owed: edited, it would
 * still read as Brigade's; cancelled, a parent waiting on its children would never wake.
 */
export const mayChangeQueued = (memberId: string | null, action: QueuedMessageAction['action']) =>
  action === 'steer' || memberId !== null
export const InterruptThread = z.object({ turnId: z.string().max(64).optional() })
export const ResolveApproval = z.object({
  approvalId: z.string(),
  approved: z.boolean(),
  reason: z.string().max(2000).optional(),
  always: z.boolean().optional(),
  /** An email's approval: the draft as the person changed it before approving. */
  edited: EditedEmail.optional(),
})

export const AnswerQuestion = z.object({ questionId: z.string(), answer: QuestionAnswer })
export const AnswerTicket = z.object({ requestId: z.string(), answer: TicketAnswer })
export const OpenBrowser = z.object({ url: z.url({ protocol: /^https?$/ }).optional() })

export const RunnerLink = z.object({
  code: z.string().trim().min(1),
  name: z.string().trim().min(1).max(120),
  platform: z.string().max(60),
  version: z.string().max(40),
  /** The computer this runner was linked as before: linking again replaces it instead of adding one. */
  computerId: z.string().max(60).optional(),
  /** This machine and runner home, hashed: a computer already linked from there is kept. */
  machineId: z.string().max(128).optional(),
})
export const RunnerLinkResult = z.object({
  /** `<workspaceId>.<secret>`: the API's front routes the runner's socket to its workspace's hub. */
  token: z.string(),
  computerId: z.string(),
  workspaceName: z.string(),
  workspaceId: z.string().optional(),
})
export type RunnerLinkResult = z.infer<typeof RunnerLinkResult>

// Browser <-> API WebSocket
export const BrowserToApi = z.discriminatedUnion('type', [
  /**
   * Follow a thread. The API replays stored events after `afterSeq`, then streams live ones.
   * With `tail` and `afterSeq` 0, it replays only the latest page, after a `history` message.
   */
  z.object({
    type: z.literal('subscribe'),
    sessionId: z.string(),
    afterSeq: z.number().int().min(0),
    tail: z.boolean().optional(),
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
  /** The dashboard is in view or not: notifications wait while a member is looking. */
  z.object({ type: z.literal('presence'), visible: z.boolean() }),
  /**
   * Still here, every 30 s, sent exactly as KEEPALIVE: a workspace's hub object answers it with
   * the same without waking, and the socket never looks idle (Cloudflare closes one silent for a
   * minute).
   */
  z.object({ type: z.literal('keepalive') }),
])
export type BrowserToApi = z.infer<typeof BrowserToApi>

export const ApiToBrowser = z.discriminatedUnion('type', [
  z.object({ type: z.literal('events'), events: z.array(SequencedEvent) }),
  /**
   * A thread followed by its tail: events before `firstSeq` are not replayed
   * (GET /threads/:id/events?before= pages them in). `context` holds the few of
   * them the whole thread needs: what it made, its preview, usage, open asks.
   * `lastSeq` is the last event replayed after it: once in, the thread has loaded.
   */
  z.object({
    type: z.literal('history'),
    sessionId: z.string(),
    firstSeq: z.number().int().positive(),
    context: z.array(SequencedEvent),
    lastSeq: z.number().int().min(0).optional(),
  }),
  z.object({
    type: z.literal('thread.updated'),
    sessionId: z.string(),
    status: z.string(),
    /** Its computer changed, or a move to another started or ended: fetch the thread again. */
    moved: z.boolean().optional(),
    /**
     * Since when its events have not reached Brigade (the runner keeps sending them); null once
     * they do again. Unset: unchanged.
     */
    eventsWaitingSince: z.iso.datetime().nullable().optional(),
    /** Whether its computer is there, with its status: on subscribing, for a dashboard back from away. */
    computer: z
      .object({ id: z.string(), online: z.boolean(), restarting: z.boolean(), status: z.string() })
      .optional(),
  }),
  z.object({
    type: z.literal('computer.updated'),
    computerId: z.string(),
    online: z.boolean(),
    /** Its runner restarts into an update: online all along, but not working for a minute. */
    restarting: z.boolean().optional(),
    /** A cloud computer's new status, when that is what changed. */
    status: z.string().optional(),
  }),
  /** A task was created, changed or removed: refetch the board. */
  z.object({ type: z.literal('task.updated'), taskId: z.string() }),
  /** A ticket was opened or resolved: refetch tickets and the badges that count them. */
  z.object({ type: z.literal('tickets.updated') }),
  /** A pull request was adopted, synced or changed: refetch pulls and their badge. */
  z.object({ type: z.literal('pulls.updated') }),
  /** A schedule was created, changed, fired or removed: refetch the list. */
  z.object({ type: z.literal('schedule.updated'), scheduleId: z.string() }),
  /** A project was created, changed or removed: refetch the sidebar and project pages. */
  z.object({ type: z.literal('projects.updated') }),
  /** The library or memory changed: open documents check whether theirs did. */
  z.object({ type: z.literal('library.updated') }),
  /** A list's items, their threads or pull requests changed (docs/lists.md). */
  z.object({ type: z.literal('lists.updated') }),
  /** A mail came, left, was handed or done, or an address changed: the Inbox and its badge refetch. */
  z.object({ type: z.literal('mail.updated') }),
  /** A teammate was created, changed or removed: the sidebar and pickers refetch. */
  z.object({ type: z.literal('teammates.updated') }),
  /** An App account or a teammate's access to one changed: lists of Apps refetch. */
  z.object({ type: z.literal('connections.updated') }),
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
  /** Keeps the socket from looking idle: Cloudflare closes one silent for a minute. */
  z.object({ type: z.literal('ping') }),
  /** The answer to the dashboard's keepalive. */
  z.object({ type: z.literal('keepalive') }),
])
export type ApiToBrowser = z.infer<typeof ApiToBrowser>
