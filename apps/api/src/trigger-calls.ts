// A teammate's trigger tools (list_triggers, create_trigger), from a thread a member
// started. A trigger lets an outside event start work, on the accounts of the member who
// asked, so each one waits for an owner's or admin's approval in a ticket, as one made on
// the Apps page is theirs alone. The call waits for the decision (like a connector write),
// so the teammate gets the trigger's URL in the same turn and can finish setting it up.
import type { ApiToRunner, ScheduleOperation, TriggerProposalPayload } from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { audit } from './audit.js'
import { appCatalog, triggerCatalog, triggersOf } from './connectors/index.js'
import type { ConnectorKind } from './connectors/types.js'
import { awaitDecision } from './connector-calls.js'
import type { Scope, ScopedDb } from './db.js'
import { createConnection } from './routes/connections.js'
import { createTrigger, urlOf } from './routes/triggers.js'
import type { WorkspaceScope } from './scope.js'
import { unavailable } from './subscriptions/index.js'
import { sealSecret } from './vault.js'

type Operation = Extract<ScheduleOperation, { name: 'list_triggers' | 'create_trigger' }>
type Session = {
  id: string
  origin: string
  playbookRunId: string | null
  startedByMemberId: string
  projectId: string | null
}
type Teammate = { id: string; name: string }
type Decided = { ticketId: string; approved: boolean; memberId: string }
type Output = ({ error: string } | { output: unknown }) & { decision?: Decided }

/** How the header goes, for a sender the teammate sets up. */
const SIGNATURE =
  'X-Brigade-Signature: sha256=<hex HMAC-SHA256 of the raw body, keyed with the secret>'

/** "Stripe · acme", "Custom app · Sentry": an App's account as people name it. */
const accountName = (c: { kind: string; label: string; externalAccount: string | null }) =>
  c.kind === 'webhook'
    ? `Custom app · ${c.label}`
    : `${appCatalog[c.kind as ConnectorKind]?.name ?? c.kind} · ${c.externalAccount ?? c.label}`

export async function handleTriggerCall(
  db: ScopedDb,
  scope: Scope,
  session: Session,
  teammate: Teammate,
  op: Operation,
  /** Tells the runner the call waits for a person, with the ticket it waits on. */
  pending: (message: { ticketId: string; target: string; reason: string }) => void,
): Promise<Output> {
  if (op.name === 'list_triggers') {
    const [connections, mine] = await Promise.all([
      db.connection.findMany({
        where: { status: { not: 'removed' } },
        select: { id: true, kind: true, label: true, externalAccount: true },
        orderBy: { createdAt: 'asc' },
      }),
      // Only those on the accounts of the person in this thread, which a custom app's URL is a key to:
      // none to a thread an event, a schedule or a playbook started, which no person is in.
      session.origin === 'member' && !session.playbookRunId
        ? db.trigger.findMany({
            where: { teammateId: teammate.id, createdByMemberId: session.startedByMemberId },
            include: {
              connection: { select: { kind: true, label: true, externalAccount: true } },
            },
            orderBy: { createdAt: 'asc' },
          })
        : [],
    ])
    const catalog = triggerCatalog() as Record<string, ReturnType<typeof triggerCatalog>[string]>
    const output = {
      apps: connections
        .filter((c) => (catalog[c.kind]?.length ?? 0) > 0)
        .map((c) => ({
          connectionId: c.id,
          app: accountName(c),
          ...(unavailable(c.kind as ConnectorKind)
            ? { unavailable: unavailable(c.kind as ConnectorKind) }
            : {}),
          events: catalog[c.kind]!.map((e) => ({
            event: e.event,
            label: e.label,
            description: e.description,
            options: e.options.map((o) => ({
              name: o.name,
              label: o.label,
              required: Boolean(o.required),
              ...(o.help ? { help: o.help } : {}),
            })),
          })),
        })),
      customApp:
        'Any other app or service that can send a webhook: create_trigger with customApp (its name) and ' +
        'event "received" adds it, with a URL of its own for the trigger.',
      yourTriggers: mine.map((t) => ({
        triggerId: t.id,
        label: t.label,
        app: accountName(t.connection),
        event: t.event,
        ...(t.pathToken ? { url: urlOf(t.pathToken) } : {}),
        instructions: t.instructions ?? '',
      })),
    }
    return { output }
  }

  // An event cannot set up more work for events, nor a schedule's run, nor a playbook's.
  if (session.playbookRunId) return { error: "A playbook's run sets up no trigger." }
  if (session.origin !== 'member')
    return { error: 'Triggers are set up only from a thread a person started.' }
  if (!op.connectionId === !op.customApp)
    return {
      error: 'Give either connectionId (from list_triggers) or customApp (a new custom app)',
    }

  // Checked now, so a person approves only what can be made.
  const connection = op.connectionId
    ? await db.connection.findFirst({ where: { id: op.connectionId, status: { not: 'removed' } } })
    : null
  if (op.connectionId && !connection)
    return { error: 'No App account has that connectionId; list_triggers shows them' }
  const kind = (connection?.kind ?? 'webhook') as ConnectorKind
  const definition = triggersOf(kind)[op.event]
  if (!definition)
    return {
      error: `No event "${op.event}" there: ${Object.keys(triggersOf(kind)).join(', ')}`,
    }
  const reason = unavailable(kind)
  if (reason) return { error: reason }
  for (const option of definition.options ?? [])
    if (option.required && !op.options[option.name]?.trim())
      return { error: `${option.label} (${option.name}) is required` }
  const custom = kind === 'webhook'
  if (custom && !op.verification)
    return {
      error:
        'Give verification: hmac when the sender can sign its body with a secret, none when it cannot',
    }

  const app = connection ? accountName(connection) : `Custom app · ${op.customApp}`
  const payload: TriggerProposalPayload = {
    triggerAction: 'create',
    teammateId: teammate.id,
    appConnectionId: connection?.id ?? null,
    ...(op.customApp ? { customApp: op.customApp } : {}),
    app,
    event: op.event,
    eventLabel: definition.label,
    options: Object.fromEntries(
      Object.entries(op.options).filter(
        ([name, value]) => value && (definition.options ?? []).some((o) => o.name === name),
      ),
    ),
    label: op.label,
    instructions: op.instructions,
    ...(custom ? { verification: op.verification } : {}),
    ...(op.reason ? { reason: op.reason } : {}),
  }
  const ticket = await db.ticket.create({
    data: {
      sessionId: session.id,
      type: 'approval',
      title: `${teammate.name}: add the trigger "${op.label}"`,
      payload: payload as never,
    } as never,
  })
  await audit({
    ...scope,
    actor: { type: 'teammate', id: teammate.id },
    action: 'trigger.proposed',
    target: { type: 'ticket', id: ticket.id },
    data: { app, event: op.event, label: op.label, sessionId: session.id },
  })
  pending({
    ticketId: ticket.id,
    target: op.label,
    reason:
      `${teammate.name} asks to start a thread on each "${definition.label}" event from ${app}, with standing ` +
      `instructions, on the accounts of the member who started this thread. Only an owner or admin can allow it.` +
      (op.reason ? ` ${op.reason}` : ''),
  })
  const decided = await awaitDecision(ticket.id)
  const decision = { ticketId: ticket.id, approved: decided.approved, memberId: decided.memberId }
  if (!decided.approved)
    return {
      error: `A person declined this trigger${decided.reason ? `: ${decided.reason}` : ''}`,
      decision,
    }

  try {
    const approver = await db.member.findFirst({
      where: { id: decided.memberId },
      select: { userId: true, role: true },
    })
    if (!approver)
      return { error: 'The member who approved it is no longer in the workspace', decision }
    // The approver adds the custom app, as they would on the Apps page.
    const as: WorkspaceScope = {
      ...scope,
      memberId: decided.memberId,
      userId: approver.userId,
      role: approver.role as WorkspaceScope['role'],
    }
    const connectionId =
      connection?.id ??
      (
        await createConnection(
          as,
          { kind: 'webhook', label: op.customApp!, externalAccount: null },
          null,
        )
      ).id
    const created = await createTrigger(
      db,
      scope,
      {
        connectionId,
        teammateId: teammate.id,
        label: op.label,
        event: op.event,
        options: payload.options,
        ...(custom ? { verification: op.verification } : {}),
        projectId: session.projectId,
        instructions: op.instructions,
      },
      {
        // Its threads run on the accounts of the member who asked, as a schedule's do.
        createdByMemberId: session.startedByMemberId,
        actor: { type: 'teammate', id: teammate.id },
        approvedByMemberId: decided.memberId,
      },
    )
    // The signing secret goes to the vault, for the teammate to set up the sender with; never in a reply.
    const credential = created.signingSecret
      ? await keepSigningSecret(db, scope, {
          secret: created.signingSecret,
          label: op.label,
          url: created.url!,
          teammateId: teammate.id,
          memberId: decided.memberId,
        })
      : null
    // Its ticket names what it made.
    await db.ticket.updateMany({
      where: { id: ticket.id },
      data: {
        payload: { ...payload, appConnectionId: connectionId, triggerId: created.id } as never,
      },
    })
    const output = {
      triggerId: created.id,
      label: op.label,
      app,
      ...(created.url ? { url: created.url } : {}),
      ...(credential
        ? {
            signingSecret: {
              credentialId: credential.id,
              name: credential.name,
              how: `Load it with use_credential (variable SECRET); the sender signs each body: ${SIGNATURE}`,
            },
          }
        : {}),
      note:
        (created.url
          ? 'Give the sender this URL (configure it yourself if you can reach it, else tell the person where to paste it). ' +
            'An "id" field in the JSON body keeps a retried event from starting a second thread. '
          : '') +
        'Each event now starts a thread for you, with the instructions first. Tell the person in a line what it listens to.',
    }
    return { output, decision }
  } catch (error) {
    if (error instanceof HTTPException) return { error: error.message, decision }
    throw error
  }
}

/** A custom app's signing secret, as a credential only the teammate may use, without asking. */
async function keepSigningSecret(
  db: ScopedDb,
  scope: Scope,
  input: { secret: string; label: string; url: string; teammateId: string; memberId: string },
) {
  const vaultSecretId = await sealSecret(db, scope, { value: input.secret })
  const credential = await db.credential.create({
    data: {
      kind: 'other',
      name: `Signing secret · ${input.label}`.slice(0, 80),
      details: {
        url: input.url,
        notes: `Signs the events sent to this trigger's URL: ${SIGNATURE}`,
      },
      access: 'selected',
      vaultSecretId,
      // The member who approved keeps it: they may change it and share it.
      createdByMemberId: input.memberId,
      createdByTeammateId: input.teammateId,
    } as never,
  })
  await db.credentialGrant.create({
    data: {
      credentialId: credential.id,
      teammateId: input.teammateId,
      withoutAsking: true,
    } as never,
  })
  await audit({
    ...scope,
    actor: { type: 'teammate', id: input.teammateId },
    action: 'credential.created',
    target: { type: 'credential', id: credential.id },
    data: { kind: 'other', name: credential.name, approvedBy: input.memberId },
  })
  return credential
}
