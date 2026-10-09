// Messages on the one WebSocket between a runner and the API.
import { z } from 'zod'
import { SequencedEvent } from './events.js'

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
})
export type ThreadSpec = z.infer<typeof ThreadSpec>

// Runner -> API
export const RunnerToApi = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    protocolVersion: z.number().int(),
    version: z.string(),
    platform: z.string(),
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
  /** A harness called a connector tool. The API checks grant, scope, approval and caps, then calls. */
  z.object({
    type: z.literal('connector.call'),
    callId: z.string(),
    sessionId: z.string(),
    connectionId: z.string(),
    operation: z.string(),
    input: z.unknown(),
  }),
])
export type RunnerToApi = z.infer<typeof RunnerToApi>

// API -> runner
export const ApiToRunner = z.discriminatedUnion('type', [
  z.object({ type: z.literal('welcome'), runnerId: z.string(), computerId: z.string() }),
  z.object({ type: z.literal('update.required'), minProtocolVersion: z.number().int() }),
  /** Highest contiguous seq stored per thread. The runner drops buffered events up to it. */
  z.object({ type: z.literal('ack'), sessionId: z.string(), seq: z.number().int() }),
  z.object({
    type: z.literal('thread.prompt'),
    commandId: z.string(),
    thread: ThreadSpec,
    text: z.string(),
    memberId: z.string().nullable(),
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
  z.object({ type: z.literal('thread.interrupt'), commandId: z.string(), sessionId: z.string() }),
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
  /** The connector call waits for a person's approval (ticket). */
  z.object({
    type: z.literal('connector.pending'),
    callId: z.string(),
    ticketId: z.string(),
    target: z.string(),
  }),
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
