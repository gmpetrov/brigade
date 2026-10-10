// Credentials teammates use. A runner asks for one on behalf of a thread; the
// API releases its secret to that runner only once a member mentioned the
// credential in the thread, or a person approved the request. Every release is
// audited. The runner types a website password into the teammate's browser and
// writes other kinds to an env file; neither goes into the model's context.
import {
  CredentialDetails,
  mentionedIds,
  useFor,
  type ApiToRunner,
  type CredentialSecret,
  type CredentialSummary,
  type QuestionAnswer,
  type RunnerToApi,
} from '@brigade/contracts'
import { audit } from './audit.js'
import { awaitDecision } from './connector-calls.js'
import { scoped, type Scope, type ScopedDb } from './db.js'
import { actingTeammate } from './thread-spec.js'
import { openSecret } from './vault.js'

type Row = {
  id: string
  kind: CredentialSummary['kind']
  name: string
  details: unknown
  createdByMemberId: string
  createdAt: Date
  updatedAt: Date
}

export const summarize = (row: Row): CredentialSummary => ({
  id: row.id,
  kind: row.kind,
  name: row.name,
  details: CredentialDetails.catch({}).parse(row.details),
  createdByMemberId: row.createdByMemberId,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
})

/**
 * Whether a member mentioned the credential in the thread: in a message, or
 * in an answer to the teammate's question. A webhook's payload has no member,
 * so it cannot grant a credential.
 */
export async function mentionedInThread(db: ScopedDb, sessionId: string, credentialId: string) {
  const events = await db.sessionEvent.findMany({
    where: { sessionId, type: { in: ['message.user', 'question.answered'] } },
    select: { data: true },
  })
  return events.some(({ data }) => {
    const event = data as { memberId?: string | null; text?: string; answer?: QuestionAnswer }
    if (!event.memberId) return false
    const texts =
      event.text !== undefined
        ? [event.text]
        : event.answer?.action === 'declined'
          ? []
          : Object.values(event.answer?.answers ?? {}).map((a) => a.freeform ?? '')
    return texts.some((text) => mentionedIds(text, 'credential').includes(credentialId))
  })
}

type Request = Extract<RunnerToApi, { type: 'credential.request' }>
type Runner = { computerId: string; organizationId: string; workspaceId: string }

export async function handleCredentialRequest(
  runner: Runner,
  request: Request,
  reply: (message: ApiToRunner) => void,
) {
  const scope: Scope = { organizationId: runner.organizationId, workspaceId: runner.workspaceId }
  const db = scoped(scope)
  const fail = (
    error: string,
    decision?: { ticketId: string; approved: boolean; memberId: string },
  ) =>
    reply({
      type: 'connector.result',
      callId: request.callId,
      ok: false,
      error,
      ...(decision ? { decision } : {}),
    })

  // Only threads running on this runner's own computer.
  const session = await db.session.findFirst({
    where: { id: request.sessionId, computerId: runner.computerId },
  })
  if (!session) return fail('Unknown thread')
  const teammate = await actingTeammate(db, session, request.teammateId)
  if (!teammate) return fail('That teammate is not in this thread')

  if (request.action === 'list') {
    const rows = await db.credential.findMany({ orderBy: { name: 'asc' } })
    return reply({
      type: 'connector.result',
      callId: request.callId,
      ok: true,
      output: rows.map(summarize),
    })
  }

  const row = request.credentialId
    ? await db.credential.findFirst({ where: { id: request.credentialId } })
    : null
  if (!row) return fail('No such credential. List them with list_credentials.')
  const credential = summarize(row)
  const use = useFor(credential.kind)
  if (request.use !== use)
    return fail(
      use === 'browser'
        ? `${credential.name} is a website login: use fill_credential to sign in with it in your browser.`
        : `${credential.name} is not a website login: use use_credential to get it as an env file.`,
    )

  // A member's mention allows it in this thread; otherwise a person decides now.
  let decision: { ticketId: string; approved: boolean; memberId: string } | undefined
  if (!(await mentionedInThread(db, session.id, credential.id))) {
    const where = credential.details.url ?? credential.details.host
    const reason = `${teammate.name} asks to ${
      use === 'browser' ? 'sign in with' : 'use'
    } ${credential.name}${where ? ` (${where})` : ''}. Nobody mentioned it in this thread.${
      request.purpose ? ` ${request.purpose}` : ''
    }`
    const ticket = await db.ticket.create({
      data: {
        sessionId: session.id,
        type: 'approval',
        title: `${teammate.name}: use ${credential.name}`,
        payload: { credentialId: credential.id, credential: credential.name, use, reason },
      } as never,
    })
    reply({
      type: 'connector.pending',
      callId: request.callId,
      ticketId: ticket.id,
      target: credential.name,
      reason,
    })
    const decided = await awaitDecision(ticket.id)
    decision = { ticketId: ticket.id, approved: decided.approved, memberId: decided.memberId }
    if (!decided.approved)
      return fail(`A person denied this${decided.reason ? `: ${decided.reason}` : ''}`, decision)
  }

  const secret = await openSecret<CredentialSecret>(db, scope, row.vaultSecretId)
  await audit({
    ...scope,
    actor: { type: 'teammate', id: teammate.id },
    action: 'credential.released',
    target: { type: 'credential', id: credential.id },
    data: {
      sessionId: session.id,
      use,
      ...(decision
        ? { ticketId: decision.ticketId, approvedBy: decision.memberId }
        : { via: 'mention' }),
    },
  })
  reply({
    type: 'connector.result',
    callId: request.callId,
    ok: true,
    output: { credential, secret },
    ...(decision ? { decision } : {}),
  })
}
