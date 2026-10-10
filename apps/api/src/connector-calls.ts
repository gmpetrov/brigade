// Every connector call goes through here (spec hard constraint 4): the API
// checks grant, scope, approval and caps, adds the credential from the vault,
// makes the request and records it. The credential never leaves this process.
import type {
  ApiToRunner,
  PermissionPolicy,
  RunnerToApi,
  ThreadAttachmentRef,
} from '@brigade/contracts'
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
import {
  redact,
  type ApiKeyCredential,
  type ConnectorContext,
  type ConnectorKind,
  type Operation,
} from './connectors/types.js'
import { writeCapReached } from './caps.js'
import { scoped, type Scope, type ScopedDb } from './db.js'
import { actingTeammate } from './thread-spec.js'
import { openSecret, replaceSecret } from './vault.js'

type Decision = { approved: boolean; memberId: string; reason?: string }
const waiting = new Map<string, (decision: Decision) => void>()

type Call = Extract<RunnerToApi, { type: 'connector.call' }>
type Runner = { computerId: string; organizationId: string; workspaceId: string }

export async function handleConnectorCall(
  runner: Runner,
  call: Call,
  reply: (message: ApiToRunner) => void,
) {
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
  })
  const operation =
    connection && (connectors[connection.kind]?.operations[call.operation] as Operation | undefined)
  if (!connection || !operation)
    return result({ ok: false, error: 'Unknown connection or operation' })

  const record = (data: { result: string; target: string; error?: string; ticketId?: string }) =>
    db.connectionCall.create({
      data: {
        sessionId: session.id,
        connectionId: connection.id,
        teammateId: teammate.id,
        operation: call.operation,
        write: operation.write,
        ...data,
      } as never,
    })

  const input = operation.input.safeParse(call.input)
  if (!input.success)
    return result({
      ok: false,
      error: `Invalid input: ${input.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
    })
  const target = operation.target(input.data)

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
  if (operation.write && grant.scope !== 'read_write') {
    await record({ result: 'denied', target, error: 'read-only grant' })
    return result({
      ok: false,
      error: `${teammate.name} has read-only access to ${connection.label}`,
    })
  }

  // Approval and caps: the teammate's policy for connector writes (allow unless
  // set otherwise), then its daily write cap.
  let decision: (Decision & { ticketId: string }) | undefined
  if (operation.write) {
    const policy = (teammate.permissionPolicy as PermissionPolicy).connectorWrites ?? 'allow'
    if (policy === 'deny') {
      await record({ result: 'denied', target, error: 'policy denies connector writes' })
      return result({
        ok: false,
        error: `${teammate.name} may not make changes through connectors`,
      })
    }
    const cap = await writeCapReached(db, teammate, connection.id)
    if (cap || policy === 'ask') {
      const action = `${call.operation.replace(/_/g, ' ')} (${target})`
      const where = connection.externalAccount ?? connection.label
      const reason = cap
        ? `${teammate.name} reached its cap of ${cap.limit} write calls today on ${where}. Approving allows this one call.`
        : undefined
      const ticket = await db.ticket.create({
        data: {
          sessionId: session.id,
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
          },
        } as never,
      })
      if (cap)
        await audit({
          ...scope,
          actor: { type: 'system', id: 'brigade' },
          action: 'cap.reached',
          target: { type: 'thread', id: session.id },
          data: { ...cap, connectionId: connection.id, ticketId: ticket.id },
        })
      reply({
        type: 'connector.pending',
        callId: call.callId,
        ticketId: ticket.id,
        target,
        ...(reason ? { reason } : {}),
      })
      const decided = await awaitDecision(ticket.id)
      decision = { ...decided, ticketId: ticket.id }
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
    const fetch = await authorisedFetch(db, scope, connection)
    const output = await operation.run(
      {
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
      },
      input.data,
    )
    await record({ result: 'ok', target, ...(decision ? { ticketId: decision.ticketId } : {}) })
    return result({ ok: true, output, attachments: kept, ...(decision ? { decision } : {}) })
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error))
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
  connection: { id: string; kind: ConnectorKind; vaultSecretId: string | null },
): Promise<ConnectorContext['fetch']> {
  if (!connection.vaultSecretId) throw new Error('This connection has no credential; reconnect it')
  const secretId = connection.vaultSecretId
  const needsReauth = () =>
    db.connection.updateMany({ where: { id: connection.id }, data: { status: 'needs_reauth' } })

  if (connectors[connection.kind]?.auth === 'api_key') {
    const { apiKey } = await openSecret<ApiKeyCredential>(db, scope, secretId)
    const authorised = async (url: string, init: RequestInit = {}) => {
      const response = await fetch(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${apiKey}` },
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

  let credential = await openSecret<GoogleCredential>(db, scope, secretId)
  const refresh = async () => {
    try {
      credential = await refreshGoogle(credential)
    } catch (error) {
      await needsReauth()
      throw error
    }
    await replaceSecret(db, scope, secretId, credential)
  }
  if (credential.expiresAt < Date.now() + 60_000) await refresh()
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

/** Whether a connector call is waiting on this ticket in this process. */
export const isWaiting = (ticketId: string) => waiting.has(ticketId)

/** Wait in this process for a person to decide an approval ticket (see decideTicket). */
export const awaitDecision = (ticketId: string) =>
  new Promise<Decision>((resolve) => waiting.set(ticketId, resolve))

/**
 * A person approves or denies a connector write. Returns false when the call
 * is no longer waiting (for instance after an API restart).
 */
export async function decideTicket(
  scope: Scope & { memberId: string },
  ticketId: string,
  decision: { approved: boolean; reason?: string },
): Promise<boolean> {
  const db = scoped(scope)
  const ticket = await db.ticket.findFirst({
    where: { id: ticketId, type: { in: ['approval', 'cap'] }, status: 'open' },
  })
  if (!ticket) return false
  const resolve = waiting.get(ticketId)
  waiting.delete(ticketId)
  await db.ticket.updateMany({
    where: { id: ticketId, status: 'open' },
    data: {
      status: resolve ? (decision.approved ? 'approved' : 'denied') : 'resolved',
      resolvedByMemberId: scope.memberId,
      resolvedAt: new Date(),
    },
  })
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: `${ticket.type === 'cap' ? 'cap' : 'approval'}.${
      resolve
        ? decision.approved
          ? ticket.type === 'cap'
            ? 'allowed'
            : 'approved'
          : 'denied'
        : 'expired'
    }`,
    target: { type: 'ticket', id: ticketId },
    ...(decision.reason ? { data: { reason: decision.reason } } : {}),
  })
  resolve?.({
    approved: decision.approved,
    memberId: scope.memberId,
    ...(decision.reason ? { reason: decision.reason } : {}),
  })
  return Boolean(resolve)
}
