// Every connector call goes through here (spec hard constraint 4): the API
// checks grant, scope, approval and caps, adds the credential from the vault,
// makes the request and records it. The credential never leaves this process.
import type {
  ApiToRunner,
  PermissionPolicy,
  RunnerToApi,
  ThreadAttachmentRef,
} from '@brigade/contracts'
import { usableIn } from './apps.js'
import { keepConnectorFile, readAttachment } from './attachments.js'
import { audit } from './audit.js'
import { connectors } from './connectors/index.js'
import {
  GitHubInstallationGone,
  githubHeaders,
  installationToken,
  type GitHubCredential,
} from './connectors/github-app.js'
import { refreshGoogle, type GoogleCredential } from './connectors/google-oauth.js'
import { refreshMcp, type McpCredential } from './connectors/mcp.js'
import { serverOf } from './mcp-servers.js'
import { isMcp, mcpOperation } from './mcp-tools.js'
import {
  redact,
  type ApiKeyCredential,
  type ConnectorContext,
  type ConnectorKind,
  type Operation,
} from './connectors/types.js'
import { writeCapReached } from './caps.js'
import {
  afterPlaybookDecision,
  numbersOf,
  playbookVerdict,
  reserveAllowance,
} from './playbook-autonomy.js'
import { playbookAccepts, playbookAccount, playbookActionOf, threadPlaybook } from './playbooks.js'
import { notePullRequestCall } from './pull-requests.js'
import { reviewOnCreate } from './reviews.js'
import { scoped, type Scope, type ScopedDb } from './db.js'
import { timeWhenSent } from './mail/gmail-outbound.js'
import {
  decideHeld,
  holdCall,
  onDecided,
  type Decision,
  type Live,
  type Resume,
} from './held-calls.js'
import { actingTeammate, askedBy } from './thread-spec.js'
import { openSecret, replaceSecret } from './vault.js'

export type { Decision }

type Call = Extract<RunnerToApi, { type: 'connector.call' }>
type Runner = { computerId: string; organizationId: string; workspaceId: string }

/** The operation that sends a mailbox's email, by its kind: its mailbox's sendPolicy applies. */
const MAIL_SENDS: Partial<Record<string, string>> = { email: 'email_send', gmail: 'gmail_send' }

/**
 * A runner's connector call. One that asks a person is held with its ticket (src/held-calls.ts)
 * and made once they decide, with `resume`: then nothing is asked again, and a denial stands.
 */
export async function handleConnectorCall(
  runner: Runner,
  call: Call,
  reply: (message: ApiToRunner) => void,
  options: { live?: Live; resume?: Resume } = {},
) {
  const { resume } = options
  const scope: Scope = { organizationId: runner.organizationId, workspaceId: runner.workspaceId }
  const db = scoped(scope)
  const result = (r: {
    ok: boolean
    output?: unknown
    error?: string
    decision?: Decision & { ticketId: string }
    attachments?: ThreadAttachmentRef[]
  }) =>
    reply({
      type: 'connector.result',
      callId: call.callId,
      ok: r.ok,
      ...(r.output === undefined ? {} : { output: r.output }),
      ...(r.error ? { error: r.error } : {}),
      ...(r.attachments?.length ? { attachments: r.attachments } : {}),
      ...(r.decision
        ? {
            decision: {
              ticketId: r.decision.ticketId,
              approved: r.decision.approved,
              memberId: r.decision.memberId,
            },
          }
        : {}),
    })

  // Only threads running on this runner's own computer.
  const session = await db.session.findFirst({
    where: { id: call.sessionId, computerId: runner.computerId },
  })
  if (!session) return result({ ok: false, error: 'Unknown thread' })
  const teammate = await actingTeammate(db, session, call.teammateId)
  if (!teammate) return result({ ok: false, error: 'That teammate is not in this thread' })
  const connection = await db.connection.findFirst({
    where: { id: call.connectionId, status: { not: 'removed' } },
    include: { app: { select: { disabledTools: true } } },
  })
  // An MCP server's tools are its own, listed with the account's token.
  const operation =
    connection &&
    (isMcp(connection.kind)
      ? await mcpOperation(db, scope, connection, call.operation).catch(() => undefined)
      : (connectors[connection.kind]?.operations[call.operation] as Operation | undefined))
  if (!connection || !operation)
    return result({ ok: false, error: 'Unknown connection or operation' })

  // In a playbook's thread: its Apps alone, and the action of its manifest the call is.
  const playbook = await threadPlaybook(db, session.playbookRunId, session.playbookTeammate)
  const playbookActionKey = playbook
    ? playbookActionOf(playbook.actions, connection.kind, call.operation)
    : null
  const record = (data: {
    result: string
    target: string
    error?: string
    ticketId?: string
    simulated?: boolean
    input?: unknown
  }) =>
    db.connectionCall.create({
      data: {
        sessionId: session.id,
        connectionId: connection.id,
        teammateId: teammate.id,
        operation: call.operation,
        write: operation.write,
        ...(playbookActionKey ? { playbookActionKey } : {}),
        ...data,
      } as never,
    })

  let input = operation.input.safeParse(call.input)
  if (!input.success)
    return result({
      ok: false,
      error: `Invalid input: ${input.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
    })
  let target = operation.target(input.data)
  // Brigade's own connectors act on Brigade's data, for this thread; so does Gmail's sending,
  // which Brigade holds for its window to cancel it (src/mail/gmail-outbound.ts).
  const brigade = connectors[connection.kind]?.auth === 'brigade'
  const own =
    brigade || connection.kind === 'gmail'
      ? {
          scope,
          connectionId: connection.id,
          teammateId: teammate.id,
          thread: {
            id: session.id,
            projectId: session.projectId,
            teammateId: teammate.id,
            startedByMemberId: session.startedByMemberId,
            origin: session.origin,
            status: session.status,
          },
        }
      : {}
  const callContext = (extra: Partial<ConnectorContext> = {}) =>
    ({
      fetch: (url: string, init?: RequestInit) => fetch(url, init),
      callId: call.callId,
      ...own,
      ...extra,
    }) as ConnectorContext

  // Grant and scope.
  const grant = await db.grant.findFirst({
    where: { teammateId: teammate.id, connectionId: connection.id },
  })
  if (!grant) {
    await record({ result: 'denied', target, error: 'no grant' })
    return result({
      ok: false,
      error: `${teammate.name} has no access to ${connection.label}`,
    })
  }
  // A member's own account only in their threads; an App's turned-off tools nowhere.
  if (!usableIn(connection, session)) {
    await record({ result: 'denied', target, error: 'account of another member' })
    return result({
      ok: false,
      error: `${connection.label} belongs to another member and is used only in their threads`,
    })
  }
  // A member's own account answers only their requests: not in a thread another member asks in.
  if (connection.reach === 'mine') {
    const asker = await askedBy(db, session.id)
    if (asker && asker !== connection.createdByMemberId) {
      await record({ result: 'denied', target, error: 'asked by another member' })
      return result({
        ok: false,
        error: `${connection.label} is a member's own account: it is used only in threads where they alone ask, and another member takes part in this one. Ask them to use it in a thread of their own, or use an account the whole workspace shares.`,
      })
    }
  }
  if (playbook) {
    const role = playbookAccepts(playbook, connection.kind)
    if (!role) {
      await record({ result: 'denied', target, error: 'not an App of the playbook' })
      return result({
        ok: false,
        error: `The playbook ${playbook.name} does not use ${connection.label}`,
      })
    }
    // An App one of its roles accepts; where a setting picks the role's account (its inbox, its
    // analytics tool), that account alone. A server added by its URL only when picked.
    const access = playbookAccount(playbook, connection)
    if (!access) {
      await record({ result: 'denied', target, error: 'not the account of the playbook' })
      return result({
        ok: false,
        error: `The playbook ${playbook.name} uses another ${role.name} account than ${connection.label}`,
      })
    }
    if (operation.write && access !== 'read_write') {
      await record({ result: 'denied', target, error: 'read-only in the playbook' })
      return result({
        ok: false,
        error: `The playbook ${playbook.name} only reads ${connection.label}`,
      })
    }
  }
  if (connection.app.disabledTools.includes(call.operation)) {
    await record({ result: 'denied', target, error: 'tool turned off' })
    return result({ ok: false, error: `${call.operation} is turned off for ${connection.label}` })
  }
  if (operation.write && grant.scope !== 'read_write') {
    await record({ result: 'denied', target, error: 'read-only grant' })
    return result({
      ok: false,
      error: `${teammate.name} has read-only access to ${connection.label}`,
    })
  }
  // What stops the call before anyone is asked (an email's recipients, a secret in it).
  if (operation.check) {
    const problem = await operation
      .check(callContext(), input.data)
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
    if (problem) {
      await record({ result: 'denied', target, error: problem.slice(0, 1000) })
      return result({ ok: false, error: problem })
    }
  }

  // A playbook's dry run: the write is recorded with what it would have sent, and answered
  // as if it went through. Nothing leaves, and nobody is asked. A deny still stands.
  if (operation.write && playbook?.dryRun) {
    const policy = (teammate.permissionPolicy as PermissionPolicy).connectorWrites ?? 'allow'
    if (policy === 'deny') {
      await record({ result: 'denied', target, error: 'policy denies connector writes' })
      return result({
        ok: false,
        error: `${teammate.name} may not make changes through connectors`,
      })
    }
    await record({ result: 'ok', target, simulated: true, input: input.data })
    return result({
      ok: true,
      output: {
        simulated: true,
        id: `dry-run-${call.callId}`,
        note:
          `Dry run: ${call.operation} (${target}) was recorded for the report and not sent. Carry on as if ` +
          'it went through.',
      },
    })
  }

  // Approval and caps: the teammate's policy for connector writes (allow unless set otherwise),
  // in a playbook's live run its action's level instead (a deny of the teammate's still stands),
  // then the teammate's daily write cap.
  let decision: (Decision & { ticketId: string }) | undefined
  /** A playbook's write no person decided: counted toward its action's caps and listed on its sheet. */
  let onItsOwn = false
  /** A merge on its own: the head commit its checks passed on, the only one it merges. */
  let checkedSha: string | undefined
  if (operation.write) {
    const policy = (teammate.permissionPolicy as PermissionPolicy).connectorWrites ?? 'allow'
    if (policy === 'deny') {
      await record({ result: 'denied', target, error: 'policy denies connector writes' })
      return result({
        ok: false,
        error: `${teammate.name} may not make changes through connectors`,
      })
    }
    const verdict = playbook
      ? await playbookVerdict(db, scope, {
          playbook,
          actionKey: playbookActionKey,
          args: input.data,
          github: () => authorisedFetch(db, scope, connection),
        })
      : null
    if (verdict?.level === 'deny') {
      await record({ result: 'denied', target, error: 'the playbook never does this' })
      return result({ ok: false, error: verdict.reason })
    }
    const cap = await writeCapReached(db, teammate, connection.id)
    // A mailbox whose email waits for a person: every send asks, a playbook's too.
    const approves =
      MAIL_SENDS[connection.kind] === call.operation && connection.sendPolicy === 'approve'
    let asks = verdict
      ? verdict.level === 'ask' || approves
      : approves ||
        policy === 'ask' ||
        (operation.asks
          ? await operation.asks(
              callContext(),
              input.data,
              teammate.permissionPolicy as PermissionPolicy,
            )
          : false)
    let overCap: string | undefined
    if (verdict?.level === 'auto' && !cap && !resume && !approves) {
      // On its own: it first takes its share of its action's caps, atomically; past one, it asks.
      const spec = playbook?.actions.find((a) => a.key === playbookActionKey)
      const taken = spec
        ? await reserveAllowance(scope, {
            installationId: playbook!.installationId,
            action: spec,
            args: input.data,
            teammateId: teammate.id,
            sessionId: session.id,
          })
        : { reason: 'This is not one of the writes the playbook lists, so a person approves it.' }
      if ('reason' in taken) {
        asks = true
        overCap = taken.reason
      } else {
        onItsOwn = true
        checkedSha = verdict.checkedSha
      }
    }
    if (resume) {
      decision = resume.decision
    } else if (cap || asks) {
      const action = `${call.operation.replace(/_/g, ' ')} (${target})`
      const where = connection.externalAccount ?? connection.label
      const reason = cap
        ? `${teammate.name} reached its cap of ${cap.limit} write calls today on ${where}. Approving allows this one call.`
        : approves
          ? `Every email from ${where} waits for a person's approval (its mailbox's setting).`
          : verdict?.level === 'ask'
            ? verdict.reason
            : overCap
      // Held with its ticket: made once a person decides, whenever that is (src/held-calls.ts).
      // An identical call meanwhile joins this ticket.
      await holdCall(db, {
        kind: 'connector',
        sessionId: session.id,
        teammateId: teammate.id,
        callId: call.callId,
        same: { connectionId: connection.id, operation: call.operation, input: input.data },
        request: () => ({
          sessionId: call.sessionId,
          ...(call.teammateId ? { teammateId: call.teammateId } : {}),
          connectionId: call.connectionId,
          operation: call.operation,
          input: call.input,
        }),
        ticket: {
          type: cap ? 'cap' : 'approval',
          title: cap
            ? `${teammate.name} reached its write cap on ${where}: ${action}`
            : `${teammate.name}: ${action}`,
          payload: {
            connectionId: connection.id,
            connection: where,
            operation: call.operation,
            target,
            input: input.data,
            ...(cap ?? {}),
            ...(reason ? { reason } : {}),
            // A playbook's: grouped by its installation wherever it waits, and its action's
            // decisions measure trust (playbook-autonomy.ts). Null key: a write no action lists.
            ...(playbook
              ? {
                  playbookInstallationId: playbook.installationId,
                  playbookActionKey,
                  playbookRunId: playbook.runId,
                }
              : {}),
          },
        },
        pending: { target, ...(reason ? { reason } : {}) },
        reply,
        ...(options.live ? { live: options.live } : {}),
        ...(cap
          ? {
              opened: (ticketId: string) =>
                audit({
                  ...scope,
                  actor: { type: 'system', id: 'brigade' },
                  action: 'cap.reached',
                  target: { type: 'thread', id: session.id },
                  data: { ...cap, connectionId: connection.id, ticketId },
                }),
            }
          : {}),
      })
      return
    }
    if (decision) {
      const decided = decision
      const ticket = { id: decision.ticketId }
      // The person changed the draft before approving: what goes is theirs, checked again.
      if (decided.approved && decided.input && operation.editable) {
        const changes = operation.edited ? operation.edited(decided.input) : decided.input
        const edited = operation.input.safeParse({ ...(input.data as object), ...changes })
        const problem = edited.success
          ? operation.check
            ? await operation
                .check(callContext(), edited.data)
                .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
            : null
          : edited.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')
        if (!edited.success || problem) {
          await record({
            result: 'denied',
            target,
            ticketId: ticket.id,
            error: `edited: ${problem}`,
          })
          return result({
            ok: false,
            error: `The approved changes cannot go: ${problem}`,
            decision,
          })
        }
        input = edited
        target = operation.target(edited.data)
      }
      if (!decided.approved) {
        await record({
          result: 'denied',
          target,
          ticketId: ticket.id,
          ...(decided.reason ? { error: decided.reason } : {}),
        })
        return result({
          ok: false,
          error: `A person denied this${decided.reason ? `: ${decided.reason}` : ''}`,
          decision,
        })
      }
    }
  }

  // Files the call brings into the thread, put in the teammate's folder before it sees the result.
  const kept: ThreadAttachmentRef[] = []
  try {
    const fetch = brigade
      ? (url: string, init?: RequestInit) => globalThis.fetch(url, init)
      : await authorisedFetch(db, scope, connection)
    const output = await operation.run(
      {
        ...own,
        ...(decision ? { approvedByMemberId: decision.memberId } : {}),
        fetch,
        callId: call.callId,
        keepFile: async (file) => {
          const ref = await keepConnectorFile(db, scope, session, connection.id, file, { fetch })
          kept.push(ref)
          return ref
        },
        readFile: async (id) => {
          // Only what this thread's teammates uploaded to send.
          const row = await db.attachment.findFirst({
            where: { id, source: 'teammate', sessionId: session.id, status: 'ready' },
          })
          if (!row) throw new Error(`No file ${id} to send from this thread`)
          return {
            name: row.name,
            contentType: row.contentType,
            bytes: await readAttachment(scope, row.id),
          }
        },
        ...(checkedSha ? { checkedSha } : {}),
      },
      input.data,
    )
    await record({
      result: 'ok',
      target,
      ...(decision ? { ticketId: decision.ticketId } : {}),
      // Its numbers only, as its reservation keeps them for an amount cap (playbook-autonomy.ts).
      ...(onItsOwn ? { input: numbersOf(input.data) } : {}),
    })
    // The playbook's first response went out (on its own or approved): its run's time, set once.
    // Gmail's leaves later (src/mail/gmail-outbound.ts): its run is timed once it has.
    if (playbook?.firstResponse && !playbook.dryRun && playbookActionKey === playbook.firstResponse)
      await (
        connection.kind === 'gmail' && call.operation === 'gmail_send'
          ? timeWhenSent(db, (output as { id?: unknown } | null)?.id, playbook.runId)
          : db.playbookRun.updateMany({
              where: { id: playbook.runId, firstResponseAt: null },
              data: { firstResponseAt: new Date() },
            })
      ).catch((error) => console.warn(`first response bookkeeping failed: ${String(error)}`))
    // Pull requests a teammate opens, reviews or merges: Brigade keeps them, their reviews and merges.
    if (connection.kind === 'github')
      await notePullRequestCall(db, scope, {
        sessionId: session.id,
        teammateId: teammate.id,
        operation: call.operation,
        input: input.data as Record<string, unknown>,
        output,
      }).catch((error) => console.warn(`pull request bookkeeping failed: ${String(error)}`))
    // One it opens gets a review, or keeps why not, where the teammate decides (src/reviews.ts).
    const review =
      connection.kind === 'github' && call.operation === 'github_create_pull_request'
        ? await reviewOnCreate(db, scope, {
            sessionId: session.id,
            teammateId: teammate.id,
            input: input.data as Record<string, unknown>,
            output,
          }).catch((error) => {
            console.warn(`review on create failed: ${String(error)}`)
            return undefined
          })
        : undefined
    return result({
      ok: true,
      output: review ? { ...(output as object), ...review } : output,
      attachments: kept,
      ...(decision ? { decision } : {}),
    })
  } catch (error) {
    // The provider refused the account's sign-in: say how its owner renews it, from a ticket.
    const expired = await db.connection.count({
      where: { id: connection.id, status: 'needs_reauth' },
    })
    const account = connection.externalAccount ?? connection.label
    const message =
      redact(error instanceof Error ? error.message : String(error)) +
      (expired
        ? `\nThe sign-in of ${account} expired: open an access ticket (kind connection, app.kind ${connection.kind}, app.account "${account}") so its owner reconnects it from the ticket.`
        : '')
    // A call on its own keeps its share of its action's caps even when it fails: the provider
    // may have done the write before its answer was lost, and a retry must not go past the cap.
    await record({
      result: 'error',
      target,
      error: message.slice(0, 1000),
      ...(decision ? { ticketId: decision.ticketId } : {}),
    })
    return result({ ok: false, error: message, ...(decision ? { decision } : {}) })
  }
}

/**
 * A fetch that adds the connection's credential from the vault, refreshing it
 * when needed. Marks the connection needs_reauth when the vendor refuses it.
 */
export async function authorisedFetch(
  db: ScopedDb,
  scope: Scope,
  connection: { id: string; kind: ConnectorKind; vaultSecretId: string | null; appId?: string },
): Promise<ConnectorContext['fetch']> {
  // An MCP server added by its URL signs in its own way: its OAuth, a pasted key, or nothing.
  const custom =
    connection.kind === 'mcp' && connection.appId
      ? (await serverOf(db, { kind: connection.kind, appId: connection.appId }))?.server
      : undefined
  if (custom?.auth === 'none') return (url, init) => fetch(url, init)
  if (!connection.vaultSecretId) throw new Error('This connection has no credential; reconnect it')
  const secretId = connection.vaultSecretId
  const needsReauth = () =>
    db.connection.updateMany({ where: { id: connection.id }, data: { status: 'needs_reauth' } })

  if (connectors[connection.kind]?.auth === 'api_key' || custom?.auth === 'api_key') {
    const { apiKey } = await openSecret<ApiKeyCredential>(db, scope, secretId)
    // A Bearer token, unless the server reads its key from a header of its own.
    const header = custom?.header
      ? { [custom.header]: apiKey }
      : { authorization: `Bearer ${apiKey}` }
    const authorised = async (url: string, init: RequestInit = {}) => {
      const response = await fetch(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), ...header },
      })
      if (response.status === 401) await needsReauth()
      return response
    }
    return authorised
  }

  if (connectors[connection.kind]?.auth === 'github_app') {
    const { installationId } = await openSecret<GitHubCredential>(db, scope, secretId)
    const token = async (fresh = false) => {
      try {
        return await installationToken(installationId, fresh)
      } catch (error) {
        if (!(error instanceof GitHubInstallationGone)) throw error
        await needsReauth()
        throw new Error('Brigade is no longer installed on this GitHub account; connect it again')
      }
    }
    const authorised = async (url: string, init: RequestInit = {}) => {
      const send = async (fresh = false) =>
        fetch(url, {
          ...init,
          headers: {
            ...githubHeaders,
            ...(init.headers as Record<string, string>),
            authorization: `Bearer ${await token(fresh)}`,
          },
        })
      let response = await send()
      if (response.status === 401) response = await send(true)
      return response
    }
    return authorised
  }

  // OAuth tokens the API refreshes: Google's, or an MCP server's own.
  const mcp = connectors[connection.kind]?.auth === 'mcp' || custom?.auth === 'oauth'
  let credential = await openSecret<GoogleCredential | McpCredential>(db, scope, secretId)
  // A Stripe account connected with a key, before Brigade signed in to Stripe: Stripe's MCP
  // server hides customers' details from keys, so its owner signs in again.
  if ('apiKey' in credential) {
    await needsReauth()
    throw new Error('Brigade now signs in to Stripe instead of using a key: reconnect this account')
  }
  const refresh = async () => {
    try {
      credential = mcp
        ? await refreshMcp(credential as McpCredential)
        : await refreshGoogle(credential as GoogleCredential)
    } catch (error) {
      await needsReauth()
      throw error
    }
    await replaceSecret(db, scope, secretId, credential)
  }
  // A token with nothing to refresh it (OpenRouter's 7-day key) is tried until the server
  // refuses it: refreshing would only fail, and the hour assumed for a token sent without
  // expires_in would ask for a reconnect days early.
  const refreshable = !mcp || (credential as McpCredential).refreshToken
  if (refreshable && credential.expiresAt < Date.now() + 60_000) await refresh()
  const authorised = async (url: string, init: RequestInit = {}) => {
    const send = () =>
      fetch(url, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string>),
          authorization: `Bearer ${credential.accessToken}`,
        },
      })
    let response = await send()
    if (response.status === 401) {
      await refresh()
      response = await send()
    }
    return response
  }
  return authorised
}

/** Made once decided, after any restart: the call as the runner sent it (src/held-calls.ts). */
onDecided('connector', (runner, request, reply, resume) =>
  handleConnectorCall(runner, { ...request, type: 'connector.call' } as Call, reply, { resume }),
)

/**
 * A person approves or denies a held call (a connector write, a credential, a trigger): taken
 * once, and the call is made right after, whether or not the teammate's tool still waits for it.
 * Returns false when no call waits on the ticket (one opened before held calls).
 */
export async function decideTicket(
  scope: Scope & { memberId: string },
  ticketId: string,
  decision: {
    approved: boolean
    reason?: string
    always?: boolean
    input?: Record<string, unknown>
  },
): Promise<boolean> {
  const db = scoped(scope)
  const ticket = await db.ticket.findFirst({
    where: { id: ticketId, type: { in: ['approval', 'cap'] }, status: 'open' },
  })
  if (!ticket) return false
  const held = await decideHeld(db, ticketId, {
    approved: decision.approved,
    memberId: scope.memberId,
    ...(decision.reason ? { reason: decision.reason } : {}),
    ...(decision.always && decision.approved ? { always: true } : {}),
    ...(decision.input && decision.approved ? { input: decision.input } : {}),
  })
  await db.ticket.updateMany({
    where: { id: ticketId, status: 'open' },
    data: {
      status: held ? (decision.approved ? 'approved' : 'denied') : 'resolved',
      resolvedByMemberId: scope.memberId,
      resolvedAt: new Date(),
    },
  })
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: `${ticket.type === 'cap' ? 'cap' : 'approval'}.${
      held
        ? decision.approved
          ? ticket.type === 'cap'
            ? 'allowed'
            : 'approved'
          : 'denied'
        : 'expired'
    }`,
    target: { type: 'ticket', id: ticketId },
    ...(decision.reason || decision.always
      ? {
          data: {
            ...(decision.reason ? { reason: decision.reason } : {}),
            ...(decision.always && decision.approved ? { always: true } : {}),
          },
        }
      : {}),
  })
  // A person's decision on a playbook's approval measures its action's trust: enough approvals
  // propose it act on its own (one decided in bulk is marked first, and does not count).
  if (held) await afterPlaybookDecision(db, scope, ticket)
  // Made after the person's answer: an email may take seconds to go. The minute's tick makes it
  // if this process stops first.
  if (held)
    void held
      .run()
      .catch((error: unknown) => console.error(`held call on ${ticketId} failed`, error))
  return Boolean(held)
}
