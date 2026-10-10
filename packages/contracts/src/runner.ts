// Messages on the one WebSocket between a runner and the API.
import { z } from 'zod'
import { CredentialUse } from './credentials.js'
import { QuestionAnswer, SequencedEvent } from './events.js'

/** Longest clipboard text carried between a person's browser and a desktop. */
export const CLIPBOARD_MAX = 1_000_000

export const HarnessId = z.enum(['claude_code', 'codex'])
export type HarnessId = z.infer<typeof HarnessId>

/** A harness login on the computer. The runner finds its config directory from these; never a credential. */
export const AccountRef = z.object({
  id: z.string(),
  provider: HarnessId,
  /** machine: the login already on this machine. brigade: signed in through Brigade. */
  source: z.enum(['machine', 'brigade']),
})
export type AccountRef = z.infer<typeof AccountRef>

/** A connection the teammate is granted, as tools. Never its credential. */
export const ConnectorGrant = z.object({
  connectionId: z.string(),
  kind: z.enum(['gmail', 'google_calendar', 'stripe']),
  label: z.string(),
  externalAccount: z.string().nullable(),
  scope: z.enum(['read', 'read_write']),
  operations: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      write: z.boolean(),
      inputSchema: z.record(z.string(), z.unknown()),
    }),
  ),
})
export type ConnectorGrant = z.infer<typeof ConnectorGrant>

/** What a runner needs to start or continue a thread. Never a secret. */
export const ThreadSpec = z.object({
  sessionId: z.string(),
  teammate: z.object({
    id: z.string(),
    name: z.string(),
    instructions: z.string(),
    harness: HarnessId,
    model: z.string().nullable(),
  }),
  /** allow-reads: ask before writes and commands. allow-all: never ask. */
  permissionMode: z.enum(['allow-reads', 'allow-edits', 'allow-all']),
  /** The account to run on, then the starter's other accounts with usage left, in order. */
  account: AccountRef,
  fallbacks: z.array(AccountRef),
  /** Connector tools; every call goes back to the API, which checks and makes it. */
  connectors: z.array(ConnectorGrant).default([]),
  /**
   * The teammate that started the thread. Others in it get their own harness
   * session and saved state, keyed by thread and teammate.
   */
  starter: z.boolean().default(true),
  /** Everyone in the thread, so each teammate knows who else is in it. */
  teammates: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
})
export type ThreadSpec = z.infer<typeof ThreadSpec>

// Runner -> API
export const RunnerToApi = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    protocolVersion: z.number().int(),
    version: z.string(),
    platform: z.string(),
    /** SHA-256 of the bundle it was installed from. Unset: running from source, never updated. */
    bundle: z.string().optional(),
    /** On a member's machine: which harnesses are already signed in there. Never a credential. */
    machineLogins: z
      .array(
        z.object({
          provider: HarnessId,
          loggedIn: z.boolean(),
          email: z.string().optional(),
          plan: z.string().optional(),
        }),
      )
      .optional(),
  }),
  z.object({ type: z.literal('events'), events: z.array(SequencedEvent) }),
  z.object({ type: z.literal('command.failed'), commandId: z.string(), error: z.string() }),
  z.object({ type: z.literal('terminal.output'), terminalId: z.string(), data: z.string() }),
  z.object({
    type: z.literal('terminal.exit'),
    terminalId: z.string(),
    code: z.number().int().nullable(),
  }),
  /** The vendor's sign-in page to open, and for device flows the code to enter there. */
  z.object({
    type: z.literal('account.login.prompt'),
    loginId: z.string(),
    url: z.url(),
    userCode: z.string().optional(),
    /** paste: the vendor shows a code to paste back. device: the user enters userCode at url. */
    flow: z.enum(['paste', 'device']),
  }),
  z.object({
    type: z.literal('account.login.done'),
    loginId: z.string(),
    ok: z.boolean(),
    error: z.string().optional(),
    email: z.string().optional(),
    plan: z.string().optional(),
  }),
  /** The desktop's clipboard text after a desktop.clipboard command, or why it failed. */
  z.object({
    type: z.literal('desktop.clipboard.result'),
    requestId: z.string(),
    text: z.string().max(CLIPBOARD_MAX).optional(),
    error: z.string().optional(),
  }),
  /** A harness called a connector tool. The API checks grant, scope, approval and caps, then calls. */
  z.object({
    type: z.literal('connector.call'),
    callId: z.string(),
    sessionId: z.string(),
    /** The teammate making the call. Unset: the thread's starting teammate. */
    teammateId: z.string().optional(),
    connectionId: z.string(),
    operation: z.string(),
    input: z.unknown(),
  }),
  /**
   * A teammate lists the workspace's credentials (never their secrets), or asks
   * for one to use. The API releases it once a member mentioned it in the thread
   * or approved the request. Answered like a connector call.
   */
  z.object({
    type: z.literal('credential.request'),
    callId: z.string(),
    sessionId: z.string(),
    teammateId: z.string().optional(),
    action: z.enum(['list', 'release']),
    credentialId: z.string().optional(),
    use: CredentialUse.optional(),
    /** Shown to the person approving, e.g. the page the password goes into. */
    purpose: z.string().max(500).optional(),
  }),
  /**
   * A teammate's reply mentioned others in the thread: they answer next, in
   * order. The API checks they are in the thread, the caps and the chain limit.
   */
  z.object({
    type: z.literal('thread.handoff'),
    sessionId: z.string(),
    fromTeammateId: z.string(),
    teammateIds: z.array(z.string()).min(1).max(5),
  }),
])
export type RunnerToApi = z.infer<typeof RunnerToApi>

// API -> runner
export const ApiToRunner = z.discriminatedUnion('type', [
  /** bundle: the SHA-256 of the runner bundle the API serves; a runner with another one updates. */
  z.object({
    type: z.literal('welcome'),
    runnerId: z.string(),
    computerId: z.string(),
    bundle: z.string().optional(),
  }),
  /** The API now serves another runner bundle (sent to every connected runner). */
  z.object({ type: z.literal('update.available'), bundle: z.string() }),
  z.object({
    type: z.literal('update.required'),
    minProtocolVersion: z.number().int(),
    bundle: z.string().optional(),
  }),
  /** Highest contiguous seq stored per thread. The runner drops buffered events up to it. */
  z.object({ type: z.literal('ack'), sessionId: z.string(), seq: z.number().int() }),
  z.object({
    type: z.literal('thread.prompt'),
    commandId: z.string(),
    /** The teammate that answers first. */
    thread: ThreadSpec,
    text: z.string(),
    memberId: z.string().nullable(),
    /** Teammates that answer after it, in order, each told what was said before its turn. */
    then: z.array(ThreadSpec).default([]),
    /** Set when a teammate handed the thread on: nobody wrote `text`, so it is not shown as a message. */
    handoff: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('thread.approval'),
    commandId: z.string(),
    thread: ThreadSpec,
    approvalId: z.string(),
    approved: z.boolean(),
    reason: z.string().optional(),
    memberId: z.string(),
  }),
  /** A person's answer to the harness's question. */
  z.object({
    type: z.literal('thread.answer'),
    commandId: z.string(),
    thread: ThreadSpec,
    questionId: z.string(),
    answer: QuestionAnswer,
    memberId: z.string(),
  }),
  z.object({ type: z.literal('thread.interrupt'), commandId: z.string(), sessionId: z.string() }),
  /**
   * Open a window of the teammate's browser on the computer's desktop, e.g. for
   * a person to sign it in to a site. Cloud computers only.
   */
  z.object({
    type: z.literal('browser.open'),
    commandId: z.string(),
    teammateId: z.string(),
    teammateName: z.string(),
    url: z.url({ protocol: /^https?$/ }).optional(),
  }),
  /**
   * The cloud computer's desktop clipboard, for a person in control copying
   * and pasting through the desktop view: set it to `text`, or read it.
   */
  z.object({
    type: z.literal('desktop.clipboard'),
    requestId: z.string(),
    text: z.string().max(CLIPBOARD_MAX).optional(),
  }),
  /** A person takes control of a thread: the teammate stops, now or after its current turn. */
  z.object({
    type: z.literal('thread.takeover'),
    commandId: z.string(),
    thread: ThreadSpec,
    memberId: z.string(),
    interrupt: z.boolean(),
  }),
  /** Control returns to the teammate, with the person's note and the files changed meanwhile. */
  z.object({
    type: z.literal('thread.handback'),
    commandId: z.string(),
    thread: ThreadSpec,
    memberId: z.string(),
    note: z.string(),
  }),
  /** A terminal in the thread's directory, as the teammate's user. Output streams back. */
  z.object({
    type: z.literal('terminal.open'),
    terminalId: z.string(),
    thread: ThreadSpec,
    memberId: z.string(),
    cols: z.number().int().min(20).max(400),
    rows: z.number().int().min(5).max(200),
  }),
  z.object({
    type: z.literal('terminal.input'),
    terminalId: z.string(),
    data: z.string().max(65_536),
  }),
  z.object({ type: z.literal('terminal.close'), terminalId: z.string() }),
  /** The connector call (or credential request) waits for a person's approval (ticket). */
  z.object({
    type: z.literal('connector.pending'),
    callId: z.string(),
    ticketId: z.string(),
    target: z.string(),
    /** Why a person must decide, when it is not the usual approval, e.g. a reached cap. */
    reason: z.string().optional(),
  }),
  /** Answers a connector call or a credential request. A released credential's secret is in output. */
  z.object({
    type: z.literal('connector.result'),
    callId: z.string(),
    ok: z.boolean(),
    output: z.unknown().optional(),
    error: z.string().optional(),
    /** Set when a person decided on the call. */
    decision: z
      .object({ ticketId: z.string(), approved: z.boolean(), memberId: z.string() })
      .optional(),
  }),
  /** Run the vendor's own login command into this account's config directory. */
  z.object({ type: z.literal('account.login.start'), loginId: z.string(), account: AccountRef }),
  /** The one-time code from the vendor's page. Relayed, never stored or logged. */
  z.object({
    type: z.literal('account.login.code'),
    loginId: z.string(),
    code: z.string().max(4000),
  }),
  z.object({ type: z.literal('account.login.cancel'), loginId: z.string() }),
  /** Sign the account out and delete its config directory. */
  z.object({ type: z.literal('account.remove'), account: AccountRef }),
])
export type ApiToRunner = z.infer<typeof ApiToRunner>
