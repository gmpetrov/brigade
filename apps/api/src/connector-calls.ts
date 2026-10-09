// Every connector call goes through here (spec hard constraint 4): the API
// checks grant, scope, approval and caps, adds the credential from the vault,
// makes the request and records it. The credential never leaves this process.
import type { ApiToRunner, PermissionPolicy, RunnerToApi } from '@brigade/contracts'
import { audit } from './audit.js'
import { connectors } from './connectors/index.js'
import { refreshGoogle, type GoogleCredential } from './connectors/google-oauth.js'
import {
  redact,
  type ApiKeyCredential,
  type ConnectorKind,
  type Operation,
} from './connectors/types.js'
import { writeCapReached } from './caps.js'
import { scoped, type Scope, type ScopedDb } from './db.js'
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
  }) =>
    reply({
      type: 'connector.result',
      callId: call.callId,
      ok: r.ok,
      ...(r.output === undefined ? {} : { output: r.output }),
      ...(r.error ? { error: r.error } : {}),
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
    include: { teammate: true },
  })
  if (!session) return result({ ok: false, error: 'Unknown thread' })
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
        teammateId: session.teammateId,
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
    where: { teammateId: session.teammateId, connectionId: connection.id },
  })
  if (!grant) {
    await record({ result: 'denied', target, error: 'no grant' })
    return result({
      ok: false,
      error: `${session.teammate.name} has no access to ${connection.label}`,
    })
  }
  if (operation.write && grant.scope !== 'read_write') {
    await record({ result: 'denied', target, error: 'read-only grant' })
    return result({
      ok: false,
      error: `${session.teammate.name} has read-only access to ${connection.label}`,
    })
  }

  // Approval and caps: the teammate's policy for connector writes, then its daily write cap.
  let decision: (Decision & { ticketId: string }) | undefined
  if (operation.write) {
    const configured =
      (session.teammate.permissionPolicy as PermissionPolicy).connectorWrites ?? 'ask'
    if (configured === 'deny') {
      await record({ result: 'denied', target, error: 'policy denies connector writes' })
      return result({
        ok: false,
        error: `${session.teammate.name} may not make changes through connectors`,
      })
    }
    // A webhook payload is untrusted input: writes in its threads always wait for a person.
    const policy = session.origin === 'webhook' ? 'ask' : configured
    const cap = await writeCapReached(db, session.teammate, connection.id)
    if (cap || policy === 'ask') {
      const action = `${call.operation.replace(/_/g, ' ')} (${target})`
      const where = connection.externalAccount ?? connection.label
      const reason = cap
        ? `${session.teammate.name} reached its cap of ${cap.limit} write calls today on ${where}. Approving allows this one call.`
        : session.origin === 'webhook'
          ? 'A webhook started this thread, so every change waits for a person.'
          : undefined
      const ticket = await db.ticket.create({
        data: {
          sessionId: session.id,
          type: cap ? 'cap' : 'approval',
          title: cap
            ? `${session.teammate.name} reached its write cap on ${where}: ${action}`
            : `${session.teammate.name}: ${action}`,
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
      const decided = await new Promise<Decision>((resolve) => waiting.set(ticket.id, resolve))
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

  try {
    const output = await runOperation(db, scope, connection, operation, input.data, call.callId)
    await record({ result: 'ok', target, ...(decision ? { ticketId: decision.ticketId } : {}) })
    return result({ ok: true, output, ...(decision ? { decision } : {}) })
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

/** Call the vendor with the credential from the vault, refreshing it when needed. */
async function runOperation(
  db: ScopedDb,
  scope: Scope,
  connection: { id: string; kind: ConnectorKind; vaultSecretId: string | null },
  operation: Operation,
  input: unknown,
  callId: string,
) {
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
    return operation.run({ fetch: authorised, callId }, input)
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
  return operation.run({ fetch: authorised, callId }, input)
}

/** Whether a connector call is waiting on this ticket in this process. */
export const isWaiting = (ticketId: string) => waiting.has(ticketId)

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
