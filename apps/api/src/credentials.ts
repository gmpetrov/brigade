// Credentials teammates use. A teammate may use a credential when it is shared
// with every teammate or the teammate is granted it; the API then releases its
// secret to that teammate's runner once a member mentioned it in the thread, a
// person approved the request, or the grant lets it use it without asking.
// A teammate it is not shared with asks for a grant, which only the
// credential's creator or an admin may give. Teammates also save secrets they
// produce, once a person approves. Every release and change is audited. The
// runner types a website password into the teammate's browser and writes
// other kinds to an env file; neither goes into the model's context.
import {
  CreateCredential,
  CredentialDetails,
  mentionedIds,
  SECRET_FIELD,
  useFor,
  type ApiToRunner,
  type CredentialSecret,
  type CredentialSummary,
  type QuestionAnswer,
  type RunnerToApi,
  type TeammateCredentialSave,
  type TicketAnswer,
} from '@brigade/contracts'
import { audit } from './audit.js'
import { awaitDecision, type Decision } from './connector-calls.js'
import { scoped, type Scope, type ScopedDb } from './db.js'
import { actingTeammate } from './thread-spec.js'
import { openSecret, replaceSecret, sealSecret } from './vault.js'

type Row = {
  id: string
  kind: CredentialSummary['kind']
  name: string
  details: unknown
  access: CredentialSummary['access']
  vaultSecretId: string
  previousVaultSecretId: string | null
  createdByMemberId: string
  createdByTeammateId: string | null
  createdAt: Date
  updatedAt: Date
}

export const summarize = (row: Row): CredentialSummary => ({
  id: row.id,
  kind: row.kind,
  name: row.name,
  details: CredentialDetails.catch({}).parse(row.details),
  access: row.access,
  createdByMemberId: row.createdByMemberId,
  createdByTeammateId: row.createdByTeammateId,
  hasPrevious: Boolean(row.previousVaultSecretId),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
})

const isAdminRole = (role: string | null | undefined) => role === 'owner' || role === 'admin'

/** Whether a member may change a credential and who uses it: its creator, or an admin. */
export const mayManage = (
  member: { memberId: string; role: string | null | undefined },
  row: { createdByMemberId: string },
) => isAdminRole(member.role) || row.createdByMemberId === member.memberId

/** Whether a teammate may use a credential, and whether without asking. */
export async function accessOf(
  db: ScopedDb,
  row: { id: string; access: CredentialSummary['access'] },
  teammateId: string,
) {
  const grant = await db.credentialGrant.findFirst({
    where: { credentialId: row.id, teammateId },
  })
  return {
    allowed: row.access === 'all' || Boolean(grant),
    withoutAsking: Boolean(grant?.withoutAsking),
  }
}

/**
 * The credentials members mentioned in the thread, with who mentioned each: in
 * a message, or in an answer to the teammate's question or ticket (an input, or
 * a credential granted to an access ask). A trigger's event has no member, so
 * it mentions nothing.
 */
export async function threadMentions(db: ScopedDb, sessionId: string) {
  const events = await db.sessionEvent.findMany({
    where: { sessionId, type: { in: ['message.user', 'question.answered', 'ticket.answered'] } },
    select: { data: true },
  })
  const byCredential = new Map<string, Set<string>>()
  for (const { data } of events) {
    const event = data as {
      memberId?: string | null
      text?: string
      answer?: QuestionAnswer | TicketAnswer
    }
    if (!event.memberId) continue
    const answer = event.answer
    const texts =
      event.text !== undefined
        ? [event.text]
        : !answer || answer.action === 'declined'
          ? []
          : 'replies' in answer
            ? Object.values(answer.replies).map((r) =>
                r.type === 'input'
                  ? r.text
                  : r.type === 'access' && r.granted
                    ? (r.credential ?? '')
                    : '',
              )
            : Object.values(answer.answers).map((a) => a.freeform ?? '')
    for (const text of texts)
      for (const id of mentionedIds(text, 'credential')) {
        const members = byCredential.get(id) ?? new Set<string>()
        members.add(event.memberId)
        byCredential.set(id, members)
      }
  }
  return byCredential
}

/** What a credential's ticket asks: see credentialTicketPolicy. */
export type CredentialAction = 'use' | 'grant' | 'create' | 'update'

/**
 * Whether a person already allowed this teammate this credential in the
 * thread: an approved ticket to use it, grant it, or keep it after saving it.
 * Only a grant or a save counts once the credential is no longer shared with
 * the teammate.
 */
async function approvedInThread(
  db: ScopedDb,
  sessionId: string,
  credentialId: string,
  teammateId: string,
  allowed: boolean,
) {
  const tickets = await db.ticket.findMany({
    where: {
      sessionId,
      type: 'approval',
      status: 'approved',
      AND: [
        { payload: { path: ['credentialId'], equals: credentialId } },
        { payload: { path: ['teammateId'], equals: teammateId } },
      ],
    },
    select: { payload: true },
  })
  return tickets.some(({ payload }) => {
    const action = (payload as { credentialAction?: CredentialAction }).credentialAction
    return allowed ? action !== 'update' : action === 'grant' || action === 'create'
  })
}

/**
 * Replace a credential's secret, keeping the one before so it can be restored.
 * `value` is the kind's secret field; any other stored field stays.
 */
export async function replaceCredentialSecret(db: ScopedDb, scope: Scope, row: Row, value: string) {
  const stored = await openSecret<CredentialSecret>(db, scope, row.vaultSecretId)
  if (row.previousVaultSecretId) await replaceSecret(db, scope, row.previousVaultSecretId, stored)
  else {
    const previousVaultSecretId = await sealSecret(db, scope, stored)
    await db.credential.updateMany({ where: { id: row.id }, data: { previousVaultSecretId } })
  }
  await replaceSecret(db, scope, row.vaultSecretId, {
    ...stored,
    [SECRET_FIELD[row.kind]]: value,
  })
}

/** Let a teammate use a credential from now on, without asking. */
async function grantWithoutAsking(
  db: ScopedDb,
  scope: Scope,
  credentialId: string,
  teammateId: string,
  memberId: string,
  ticketId: string,
) {
  await db.credentialGrant.upsert({
    where: { credentialId_teammateId: { credentialId, teammateId } },
    create: { credentialId, teammateId, withoutAsking: true } as never,
    update: { withoutAsking: true },
  })
  await audit({
    ...scope,
    actor: { type: 'member', id: memberId },
    action: 'credential.granted',
    target: { type: 'credential', id: credentialId },
    data: { teammateId, level: 'without_asking', ticketId },
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
  type Decided = { ticketId: string; approved: boolean; memberId: string }
  const fail = (error: string, decision?: Decided) =>
    reply({
      type: 'connector.result',
      callId: request.callId,
      ok: false,
      error,
      ...(decision ? { decision } : {}),
    })
  const succeed = (output: unknown, decision?: Decided) =>
    reply({
      type: 'connector.result',
      callId: request.callId,
      ok: true,
      output,
      ...(decision ? { decision } : {}),
    })

  // Only threads running on this runner's own computer.
  const session = await db.session.findFirst({
    where: { id: request.sessionId, computerId: runner.computerId },
  })
  if (!session) return fail('Unknown thread')
  const teammate = await actingTeammate(db, session, request.teammateId)
  if (!teammate) return fail('That teammate is not in this thread')

  /** Open a ticket on the credential, tell the runner, and wait for a person. */
  async function ask(ticket: {
    action: CredentialAction
    title: string
    target: string
    reason: string
    /** The person may also allow it for good. */
    always: boolean
    payload: Record<string, unknown>
  }): Promise<{ decided: Decision; decision: Decided }> {
    const row = await db.ticket.create({
      data: {
        sessionId: session!.id,
        type: 'approval',
        title: ticket.title,
        payload: {
          ...ticket.payload,
          credentialAction: ticket.action,
          teammateId: teammate!.id,
          reason: ticket.reason,
          ...(ticket.always ? { always: true } : {}),
        },
      } as never,
    })
    reply({
      type: 'connector.pending',
      callId: request.callId,
      ticketId: row.id,
      target: ticket.target,
      reason: ticket.reason,
      ...(ticket.always ? { always: true } : {}),
    })
    const decided = await awaitDecision(row.id)
    return {
      decided,
      decision: { ticketId: row.id, approved: decided.approved, memberId: decided.memberId },
    }
  }
  const denied = (decided: Decision, decision: Decided) =>
    fail(`A person denied this${decided.reason ? `: ${decided.reason}` : ''}`, decision)

  if (request.action === 'list') {
    // What this teammate may use, and what a member mentioned in this thread.
    const [rows, grants, mentions] = await Promise.all([
      db.credential.findMany({ orderBy: { name: 'asc' } }),
      db.credentialGrant.findMany({ where: { teammateId: teammate.id } }),
      threadMentions(db, session.id),
    ])
    const granted = new Map(grants.map((g) => [g.credentialId, g]))
    return succeed(
      rows
        .filter((r) => r.access === 'all' || granted.has(r.id) || mentions.has(r.id))
        .map((r) => ({
          ...summarize(r),
          approval: granted.get(r.id)?.withoutAsking
            ? 'not needed'
            : r.access === 'all' || granted.has(r.id)
              ? mentions.has(r.id)
                ? 'not needed in this thread'
                : 'needed unless a member mentions it'
              : 'needed from its creator or an admin: it is not shared with you',
        })),
    )
  }

  if (request.action === 'save') {
    if (!request.save) return fail('Nothing to save')
    return save(request.save)
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

  // Its grant may let it use the credential without asking; otherwise a member's
  // mention, or an earlier approval in this thread, allows it here. Not shared
  // with this teammate: only the creator's or an admin's mention does.
  const access = await accessOf(db, row, teammate.id)
  let via: 'grant' | 'mention' | 'thread' | undefined
  if (access.withoutAsking) via = 'grant'
  else {
    const mentioners = [...((await threadMentions(db, session.id)).get(row.id) ?? [])]
    const managers = access.allowed
      ? mentioners
      : (
          await db.member.findMany({
            where: { id: { in: mentioners } },
            select: { id: true, role: true },
          })
        ).filter((m) => mayManage({ memberId: m.id, role: m.role }, row))
    if (managers.length) via = 'mention'
    else if (await approvedInThread(db, session.id, row.id, teammate.id, access.allowed))
      via = 'thread'
  }

  let decision: Decided | undefined
  if (!via) {
    const where = credential.details.url ?? credential.details.host
    const what = `${use === 'browser' ? 'sign in with' : 'use'} ${credential.name}${where ? ` (${where})` : ''}`
    const asked = await ask(
      access.allowed
        ? {
            action: 'use',
            title: `${teammate.name}: use ${credential.name}`,
            target: credential.name,
            reason: `${teammate.name} asks to ${what}. Nobody mentioned it in this thread.${
              request.purpose ? ` ${request.purpose}` : ''
            }`,
            always: true,
            payload: {
              credentialId: credential.id,
              credential: credential.name,
              credentialOwnerId: row.createdByMemberId,
              use,
            },
          }
        : {
            action: 'grant',
            title: `${teammate.name} asks for access to ${credential.name}`,
            target: credential.name,
            reason: `${teammate.name} asks to ${what}, which is not shared with it. Only its creator or an admin can allow it.${
              request.purpose ? ` ${request.purpose}` : ''
            }`,
            always: true,
            payload: {
              credentialId: credential.id,
              credential: credential.name,
              credentialOwnerId: row.createdByMemberId,
              use,
            },
          },
    )
    decision = asked.decision
    if (!asked.decided.approved) return denied(asked.decided, asked.decision)
    if (asked.decided.always)
      await grantWithoutAsking(
        db,
        scope,
        credential.id,
        teammate.id,
        asked.decided.memberId,
        asked.decision.ticketId,
      )
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
        : { via: via! }),
    },
  })
  return succeed({ credential, secret }, decision)

  /** A secret the teammate produced: kept once a person approves. */
  async function save(input: TeammateCredentialSave) {
    if (input.mode === 'create') {
      const parsed = CreateCredential.safeParse({
        kind: input.kind,
        name: input.name,
        details: input.details,
        secret: { [SECRET_FIELD[input.kind]]: input.secret },
      })
      if (!parsed.success) return fail(parsed.error.issues.map((i) => i.message).join('; '))
      const details = parsed.data.details
      const where = details.url ?? details.host
      const asked = await ask({
        action: 'create',
        title: `${teammate!.name}: save the secret ${input.name}`,
        target: input.name,
        reason: `${teammate!.name} asks to save a new ${input.kind.replace('_', ' ')} secret, ${input.name}${
          where ? ` (${where})` : ''
        }${details.username ? ` for ${details.username}` : ''}. Only ${teammate!.name} may use it until someone shares it.`,
        always: true,
        payload: { credential: input.name, kind: input.kind, details },
      })
      if (!asked.decided.approved) return denied(asked.decided, asked.decision)
      const vaultSecretId = await sealSecret(db, scope, {
        [SECRET_FIELD[input.kind]]: input.secret,
      })
      const created = await db.credential.create({
        data: {
          kind: input.kind,
          name: input.name,
          details,
          access: 'selected',
          vaultSecretId,
          // The member who approved keeps it: they may change it and share it.
          createdByMemberId: asked.decided.memberId,
          createdByTeammateId: teammate!.id,
        } as never,
      })
      await db.credentialGrant.create({
        data: {
          credentialId: created.id,
          teammateId: teammate!.id,
          withoutAsking: Boolean(asked.decided.always),
        } as never,
      })
      // The approval names the credential, so it counts in this thread (approvedInThread).
      const ticket = await db.ticket.findFirst({ where: { id: asked.decision.ticketId } })
      await db.ticket.updateMany({
        where: { id: asked.decision.ticketId },
        data: { payload: { ...(ticket?.payload as object), credentialId: created.id } },
      })
      await audit({
        ...scope,
        actor: { type: 'teammate', id: teammate!.id },
        action: 'credential.created',
        target: { type: 'credential', id: created.id },
        data: {
          kind: input.kind,
          name: input.name,
          sessionId: session!.id,
          ticketId: asked.decision.ticketId,
          approvedBy: asked.decided.memberId,
        },
      })
      return succeed(summarize(created), asked.decision)
    }

    const row = await db.credential.findFirst({ where: { id: input.credentialId } })
    if (!row) return fail('No such credential. List them with list_credentials.')
    if (!(await accessOf(db, row, teammate!.id)).allowed)
      return fail(`${row.name} is not shared with ${teammate!.name}, so it cannot change it`)
    const changes = Object.fromEntries(
      Object.entries(input.changes).filter(([, v]) => v !== undefined),
    ) as typeof input.changes
    if (!input.secret && Object.keys(changes).length === 0) return fail('Nothing to change')
    const listed = [
      ...(input.secret ? ['its value'] : []),
      ...Object.keys(changes).map((k) => `its ${k}`),
    ]
    const asked = await ask({
      action: 'update',
      title: `${teammate!.name}: change ${row.name}`,
      target: row.name,
      reason: `${teammate!.name} asks to change ${listed.join(', ')} on ${row.name}.${
        input.secret ? ' The current value is kept, so it can be restored from the Secrets page.' : ''
      } Only its creator or an admin can allow it.`,
      always: false,
      payload: {
        credentialId: row.id,
        credential: row.name,
        credentialOwnerId: row.createdByMemberId,
        changes,
        secretReplaced: Boolean(input.secret),
      },
    })
    if (!asked.decided.approved) return denied(asked.decided, asked.decision)
    if (input.secret) await replaceCredentialSecret(db, scope, row, input.secret)
    const { name, ...detailChanges } = changes
    const updated = await db.credential.update({
      where: { id: row.id },
      data: {
        ...(name ? { name } : {}),
        ...(Object.keys(detailChanges).length
          ? { details: { ...CredentialDetails.catch({}).parse(row.details), ...detailChanges } }
          : {}),
      },
    })
    await audit({
      ...scope,
      actor: { type: 'teammate', id: teammate!.id },
      action: 'credential.updated',
      target: { type: 'credential', id: row.id },
      data: {
        secretReplaced: Boolean(input.secret),
        fields: Object.keys(changes),
        sessionId: session!.id,
        ticketId: asked.decision.ticketId,
        approvedBy: asked.decided.memberId,
      },
    })
    return succeed(summarize(updated), asked.decision)
  }
}
