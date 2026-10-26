// Triggers: an event on a connection starts a thread for a teammate. Events
// arrive from the vendor (see routes/events.ts and subscriptions/), are matched
// against the connection's triggers from the catalog, and each match starts one
// thread. The event is untrusted: it summons nobody, and its thread's changes
// are bounded by the teammate's grants, policy and caps like any other thread.
import { randomUUID } from 'node:crypto'
import { triggerEventText } from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { ingestExternal } from './attachments.js'
import { audit } from './audit.js'
import { authorisedFetch } from './connector-calls.js'
import { beginRun, continueRun, settleRun } from './playbooks.js'
import { triggersOf } from './connectors/index.js'
import type {
  ConnectorContext,
  ConnectorKind,
  TriggerDefinition,
  VendorEvent,
} from './connectors/types.js'
import { prisma, scoped, type Scope, type ScopedDb } from './db.js'
import { loadThread } from './thread-spec.js'
import { promptThread, promptWithAttachments, startThread } from './work.js'

const include = { teammate: true, connection: true } as const
type Trigger = NonNullable<Awaited<ReturnType<typeof findTrigger>>>
type Connection = Trigger['connection']

export const findTrigger = (pathToken: string) =>
  prisma.trigger.findUnique({ where: { pathToken }, include })

export type Delivery =
  | { ok: true; threadId: string; paused: boolean }
  /** Seen before: the thread it went to then, if it went to one. */
  | { duplicate: true; threadId?: string }
  /** A playbook's trigger while the playbook is not active: the event starts nothing. */
  | { skipped: string }
  /** A mailbox's rule past its threads for the day: the mail stays in its box, a person is told. */
  | { capped: string }
  | { error: string }

/** A mailbox rule's threads in a day, unless its perDay option says otherwise. */
export const RULE_THREADS_PER_DAY = 50
/** Events of one conversation a trigger's thread takes within the hour before it is a loop. */
const CONVERSATION_LOOP_LIMIT = 8
const CONVERSATION_LOOP_MS = 60 * 60_000

/** A claim this old, still starting, was cut off (the API restarted): another try takes it over. */
const CLAIM_STALE_MS = 10 * 60_000
/** Deliveries are remembered this long: a vendor's retry or a mailbox read again comes within it. */
const DELIVERIES_KEPT_MS = 30 * 24 * 60 * 60_000

type Claim =
  /** Ours to deliver; a try before ours may have started its thread already. */
  | { id: string; threadId?: string }
  | { duplicate: true; threadId?: string }
  /** Another try is on it right now: this one is tried again later, in case that one dies. */
  | { busy: true }

/**
 * Claim one event for a trigger before its thread starts: one row per trigger and event id
 * (TriggerDelivery), so two tries at once start one thread. A try that failed, or one a restart
 * cut off, is taken over; one that went says where it went.
 */
async function claimDelivery(db: ScopedDb, triggerId: string, eventId: string): Promise<Claim> {
  try {
    const row = await db.triggerDelivery.create({
      data: { triggerId, eventId: eventId.slice(0, 500), status: 'starting' } as never,
      select: { id: true },
    })
    // Delivered before deliveries had their own row: its audit entry says so.
    const seen = await db.auditEntry.findFirst({
      where: {
        action: 'trigger.received',
        targetId: triggerId,
        data: { path: ['eventId'], equals: eventId },
      },
    })
    if (!seen) return row
    const { threadId } = (seen.data ?? {}) as { threadId?: string }
    await db.triggerDelivery.updateMany({
      where: { id: row.id },
      data: { status: 'done', ...(threadId ? { threadId } : {}) },
    })
    return went(db, threadId)
  } catch (error) {
    if ((error as { code?: string }).code !== 'P2002') throw error
  }
  const row = await db.triggerDelivery.findFirst({
    where: { triggerId, eventId: eventId.slice(0, 500) },
  })
  if (!row) return { duplicate: true }
  const stale =
    row.status === 'failed' ||
    (row.status === 'starting' && row.updatedAt.getTime() < Date.now() - CLAIM_STALE_MS)
  if (stale) {
    const { count } = await db.triggerDelivery.updateMany({
      where: { id: row.id, status: row.status, updatedAt: row.updatedAt },
      data: { status: 'starting' },
    })
    if (count === 1) return { id: row.id, ...(row.threadId ? { threadId: row.threadId } : {}) }
  }
  // Being started by another try: not done yet, so tried again later rather than taken as done.
  if (row.status === 'starting' || row.status === 'failed') return { busy: true }
  // Delivered: never a second thread.
  return went(db, row.status === 'loop' ? undefined : (row.threadId ?? undefined))
}

/** Seen before: the thread it went to, unless that thread is gone since (deleted). */
async function went(db: ScopedDb, threadId?: string): Promise<Claim> {
  const there = threadId && (await db.session.count({ where: { id: threadId } }))
  return { duplicate: true, ...(there ? { threadId } : {}) }
}

/** Deliveries remembered long enough: deleted (src/jobs.ts). */
export const sweepDeliveries = (now = Date.now()) =>
  prisma.triggerDelivery.deleteMany({
    where: { createdAt: { lt: new Date(now - DELIVERIES_KEPT_MS) } },
  })

/**
 * Start a thread for one event, once per event id, or continue the thread of
 * the event's conversation (a reply in the same Gmail thread). When it cannot
 * start, a ticket tells the member who set the trigger up; the caller retries later,
 * and the retry, unlike a second delivery, may start it.
 */
export async function deliver(
  trigger: Trigger,
  event: Parameters<typeof deliverOnce>[1],
): Promise<Delivery> {
  if (!event.eventId) return deliverOnce(trigger, event)
  const db = scoped({ organizationId: trigger.organizationId, workspaceId: trigger.workspaceId })
  const claim = await claimDelivery(db, trigger.id, event.eventId)
  if ('busy' in claim) return { error: 'another try is starting its thread' }
  if (!('id' in claim)) return claim
  const settle = (data: { status: string; threadId?: string }) =>
    db.triggerDelivery.updateMany({ where: { id: claim.id }, data })
  // Its prompt's id is the delivery's: a try after a crash sends it once (src/runner-commands.ts).
  const commandId = `delivery:${claim.id}`
  try {
    // A try before this one started the thread and was cut off: its first message goes, once.
    const begun =
      claim.threadId &&
      (await db.session.findFirst({
        where: { id: claim.threadId, status: { not: 'failed' } },
        select: { id: true },
      }))
    if (begun) {
      const outcome = await promptThread(
        db,
        { organizationId: trigger.organizationId, workspaceId: trigger.workspaceId },
        await loadThread(db, begun.id),
        { text: event.text, memberId: null },
        { commandId },
      )
      if (outcome === 'offline') {
        await settle({ status: 'failed' })
        return { error: 'the computer is offline' }
      }
      await settle({ status: 'done', threadId: begun.id })
      return { ok: true, threadId: begun.id, paused: outcome === 'paused' }
    }
    const delivery = await deliverOnce(trigger, event, {
      commandId,
      created: (threadId) => settle({ status: 'starting', threadId }),
    })
    await settle(
      'error' in delivery
        ? { status: 'failed' }
        : 'ok' in delivery
          ? { status: 'done', threadId: delivery.threadId }
          : 'capped' in delivery
            ? { status: 'capped' }
            : 'skipped' in delivery
              ? { status: delivery.skipped.includes('loop') ? 'loop' : 'skipped' }
              : { status: 'done', ...(delivery.threadId ? { threadId: delivery.threadId } : {}) },
    )
    return delivery
  } catch (error) {
    await settle({ status: 'failed' }).catch(() => undefined)
    throw error
  }
}

async function deliverOnce(
  trigger: Trigger,
  event: {
    eventId: string | null
    eventType: string
    title: string
    text: string
    conversationKey?: string
    /** The event's files, already taken from the connection. */
    attachmentIds?: string[]
    /**
     * A mailbox's rule (an exclusive trigger): its threads stay out of the sidebar until they
     * need a person, and it starts at most its perDay threads a day.
     */
    mailbox?: boolean
  },
  /** A delivery's stable prompt id, and where its new thread's id is kept as soon as it exists. */
  once: { commandId?: string; created?: (threadId: string) => Promise<unknown> } = {},
): Promise<Delivery> {
  const scope: Scope = { organizationId: trigger.organizationId, workspaceId: trigger.workspaceId }
  const db = scoped(scope)

  const failed = async (message: string): Promise<Delivery> => {
    // Never silent: a ticket for the member who set the trigger up.
    const open = await db.ticket.count({
      where: {
        type: 'question',
        status: 'open',
        payload: { path: ['triggerId'], equals: trigger.id },
      },
    })
    if (!open)
      await db.ticket.create({
        data: {
          type: 'question',
          title: `Trigger "${trigger.label}" could not start a thread: ${message}`,
          payload: { triggerId: trigger.id, memberId: trigger.createdByMemberId },
        } as never,
      })
    return { error: message }
  }

  const received = (threadId: string, outcome: string) =>
    audit({
      ...scope,
      actor: { type: 'system', id: `trigger:${trigger.id}` },
      action: 'trigger.received',
      target: { type: 'trigger', id: trigger.id },
      data: { eventId: event.eventId, eventType: event.eventType, threadId, outcome },
    })

  // The conversation's latest thread, unless it failed.
  const ongoing =
    event.conversationKey &&
    (await db.session.findFirst({
      where: { triggerId: trigger.id, conversationKey: event.conversationKey },
      orderBy: { createdAt: 'desc' },
    }))
  // A person took it over: the conversation stays theirs. The event waits in the thread, as a
  // wake-up does, until they hand it back; no other thread starts for it.
  if (ongoing && ongoing.status !== 'failed' && ongoing.controlledByMemberId) {
    try {
      await db.wakeup.create({
        data: {
          sessionId: ongoing.id,
          teammateId: ongoing.teammateId,
          kind: 'reply',
          note: event.text,
          wakeAt: new Date(),
          sourceId: `trigger:${trigger.id}:${event.eventId ?? randomUUID()}`,
        } as never,
      })
    } catch (error) {
      // Offered twice: the first one waits already.
      if ((error as { code?: string }).code !== 'P2002') throw error
    }
    await received(ongoing.id, 'held')
    return { ok: true, threadId: ongoing.id, paused: true }
  }
  if (ongoing && ongoing.status !== 'failed') {
    // Two agents, or an agent and an autoresponder, answering each other: past so many events of
    // one conversation in an hour, the next starts nothing.
    const lately = await db.auditEntry.count({
      where: {
        action: 'trigger.received',
        targetId: trigger.id,
        at: { gt: new Date(Date.now() - CONVERSATION_LOOP_MS) },
        data: { path: ['threadId'], equals: ongoing.id },
      },
    })
    if (lately >= CONVERSATION_LOOP_LIMIT) {
      await received(ongoing.id, 'loop')
      return { skipped: 'its conversation looks like a loop: too many events within the hour' }
    }
    try {
      const outcome = await promptWithAttachments(
        db,
        scope,
        await loadThread(db, ongoing.id),
        { text: event.text, memberId: null, attachmentIds: event.attachmentIds ?? [] },
        null,
        once.commandId ? { commandId: once.commandId } : {},
      )
      if (outcome === 'offline') return failed('the computer is offline')
      await continueRun(db, ongoing.playbookRunId)
      await received(ongoing.id, outcome)
      return { ok: true, threadId: ongoing.id, paused: outcome === 'paused' }
    } catch (error) {
      if (error instanceof HTTPException) return failed(error.message)
      throw error
    }
  }

  // A mailbox's rule: so many threads a day at most; past it the mail stays in its box.
  if (event.mailbox) {
    const perDay =
      Number((trigger.options as Record<string, string>)?.perDay) || RULE_THREADS_PER_DAY
    const started = await db.session.count({
      where: { triggerId: trigger.id, createdAt: { gt: new Date(Date.now() - 86_400_000) } },
    })
    if (started >= perDay) {
      const message = `the rule "${trigger.label}" started its ${perDay} threads of the last 24 hours`
      const open = await db.ticket.count({
        where: {
          type: 'question',
          status: 'open',
          payload: { path: ['capOfTriggerId'], equals: trigger.id },
        },
      })
      if (!open)
        await db.ticket.create({
          data: {
            type: 'question',
            title: `Rule "${trigger.label}" reached ${perDay} threads in a day: new mail stays in the box`,
            payload: {
              capOfTriggerId: trigger.id,
              triggerId: trigger.id,
              memberId: trigger.createdByMemberId,
            },
          } as never,
        })
      await received('', 'capped')
      return { capped: message }
    }
  }

  // The workspace computer, or else the member who set it up's own machine.
  const computer =
    (await db.computer.findFirst({
      where: { kind: 'cloud', status: { not: 'destroyed' } },
    })) ??
    (await db.computer.findFirst({
      where: { kind: 'member_machine', memberId: trigger.createdByMemberId },
      orderBy: { updatedAt: 'desc' },
    }))
  if (!computer) return failed('the workspace has no computer')

  // A playbook's trigger: each event a run, within its runs a day (past them, the event waits).
  const run = trigger.playbookInstallationId
    ? await beginRun(db, trigger.playbookInstallationId, event.conversationKey)
    : null
  if (run && 'skipped' in run) return { skipped: run.skipped }
  if (run && 'limit' in run) return { error: run.limit }
  const runId = run?.runId

  try {
    const { thread, outcome } = await startThread(db, scope, {
      teammate: trigger.teammate,
      computer,
      memberId: trigger.createdByMemberId,
      title: event.title,
      text: event.text,
      origin: { kind: 'trigger', triggerId: trigger.id, conversationKey: event.conversationKey },
      attachmentIds: event.attachmentIds ?? [],
      projectId: trigger.projectId,
      ...(runId ? { playbookRunId: runId } : {}),
      ...(event.mailbox ? { quiet: true } : {}),
      ...once,
    })
    if (runId) await settleRun(db, runId, outcome === 'offline' ? null : thread.id)
    if (outcome === 'offline') return failed('the computer is offline')
    await received(thread.id, outcome)
    return { ok: true, threadId: thread.id, paused: outcome === 'paused' }
  } catch (error) {
    if (runId) await settleRun(db, runId, null)
    if (error instanceof HTTPException) return failed(error.message)
    throw error
  }
}

/**
 * An event's thread: its title, and its first message, the trigger's standing instructions
 * when it has some, a few lines, then the raw (untrusted) event.
 */
export function eventMessage(
  trigger: { label: string; instructions?: string | null },
  definition: TriggerDefinition,
  connection: { externalAccount: string | null; label: string },
  event: VendorEvent,
  received = new Date().toISOString(),
) {
  const { title, summary } = definition.describe(event)
  const text = triggerEventText({
    summary,
    trigger: trigger.label,
    definition: definition.label,
    source: connection.externalAccount ?? connection.label,
    type: event.type,
    id: event.id,
    received,
    payload: event.payload,
  })
  return {
    title: `${trigger.label}: ${title}`,
    text: trigger.instructions
      ? `Instructions for each event of this trigger:\n${trigger.instructions}\n\n${text}`
      : text,
  }
}

/**
 * Start a thread for each of the connection's triggers this event concerns
 * (only the given one, for a custom app's URL). failed: some thread could not
 * start, so the event should be offered again later.
 */
export async function dispatch(
  connection: Connection,
  event: VendorEvent,
  only?: Trigger,
): Promise<{
  started: number
  failed: boolean
  /** The thread that took the event, for a mailbox's rules (one at most). */
  threadId?: string
  triggerId?: string
  /** Why a mailbox's rule left it in the box: its cap for the day. */
  capped?: string
}> {
  if (connection.status === 'removed') return { started: 0, failed: false }
  const triggers = only
    ? [only]
    : await prisma.trigger.findMany({
        where: { connectionId: connection.id },
        include,
        // A mailbox's rules in their order: the first that matches takes the mail.
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      })
  const catalog = triggersOf(connection.kind as ConnectorKind)
  const scope: Scope = {
    organizationId: connection.organizationId,
    workspaceId: connection.workspaceId,
  }
  // The credential is opened only if a trigger needs to ask the vendor (Gmail searches).
  let fetch: ConnectorContext['fetch'] | undefined
  const ctx = {
    fetch: async (url: string, init?: RequestInit) => {
      fetch ??= await authorisedFetch(scoped(scope), scope, connection)
      return fetch(url, init)
    },
  }

  // The event's files, taken once for every trigger it starts a thread for.
  let attachmentIds: string[] | undefined

  // A mailbox's conversation stays with the rule whose thread already holds it, even when an
  // earlier rule would match its next mail now (a reply whose subject says "urgent").
  const exclusive = triggers.some((t) => catalog[t.event]?.exclusive)
  if (exclusive && triggers.length > 1) {
    const keys = new Set(
      triggers.map((t) => catalog[t.event]?.conversation?.(event)).filter((k): k is string => !!k),
    )
    if (keys.size) {
      const holder = await prisma.session.findFirst({
        where: {
          triggerId: { in: triggers.map((t) => t.id) },
          conversationKey: { in: [...keys] },
          status: { not: 'failed' },
        },
        orderBy: { createdAt: 'desc' },
        select: { triggerId: true },
      })
      if (holder?.triggerId) {
        const first = triggers.findIndex((t) => t.id === holder.triggerId)
        if (first > 0) triggers.unshift(...triggers.splice(first, 1))
      }
    }
  }

  let started = 0
  let failed = false
  for (const trigger of triggers) {
    const definition = catalog[trigger.event]
    if (!definition?.events.includes(event.type)) continue
    const options = (trigger.options ?? {}) as Record<string, string>
    // Brigade's addresses: an agent's rule is for its project's variant only.
    if (
      connection.kind === 'email' &&
      'projectId' in (event.payload ?? {}) &&
      (trigger.projectId ?? null) !==
        ((event.payload as { projectId?: string | null }).projectId ?? null)
    )
      continue
    const conversationKey = definition.conversation?.(event)
    // A reply in a conversation this trigger already took up continues it even if its
    // filter would not match (a reply to support@ comes back to the inbox's own address).
    const ongoing =
      conversationKey &&
      (await prisma.session.count({ where: { triggerId: trigger.id, conversationKey } })) > 0
    if (
      !ongoing &&
      definition.matches &&
      !(await definition.matches(event, options, { ...ctx, connectionId: connection.id }))
    )
      continue
    // A rule whose teammate was archived: the mail is not lost, a person is told.
    if (trigger.teammate.archivedAt) {
      if (definition.exclusive) {
        await deliverToNobody(trigger, `${trigger.teammate.name} is archived`)
        continue
      }
      continue
    }
    const files = definition.attachments?.(event) ?? []
    if (files.length > 0 && !attachmentIds) {
      try {
        attachmentIds = await ingestExternal(scoped(scope), scope, connection.id, files, ctx)
      } catch (error) {
        // The bucket is unreachable: offer the event again later rather than lose its files.
        console.error(`event ${event.id}: could not keep its files`, error)
        failed = true
        break
      }
    }
    const { title, text } = eventMessage(trigger, definition, connection, event)
    const delivery = await deliver(trigger, {
      eventId: event.id,
      eventType: event.type,
      title,
      text,
      conversationKey,
      ...(files.length > 0 ? { attachmentIds } : {}),
      ...(definition.exclusive ? { mailbox: true } : {}),
    })
    if ('error' in delivery) failed = true
    if ('ok' in delivery) started++
    // A mailbox's rules: the first that matched takes the mail, the others never see it.
    if (definition.exclusive) {
      if ('ok' in delivery)
        return { started, failed, threadId: delivery.threadId, triggerId: trigger.id }
      if ('capped' in delivery)
        return { started, failed, capped: delivery.capped, triggerId: trigger.id }
      // Seen before (the reader read it again): where it went then.
      if ('duplicate' in delivery)
        return {
          started,
          failed,
          triggerId: trigger.id,
          ...(delivery.threadId ? { threadId: delivery.threadId } : {}),
        }
      if ('error' in delivery) return { started, failed, triggerId: trigger.id }
    }
  }
  return { started, failed }
}

/** A mailbox's rule that cannot take a mail (its teammate archived): a ticket, once, for its owner. */
async function deliverToNobody(trigger: Trigger, reason: string) {
  const db = scoped({ organizationId: trigger.organizationId, workspaceId: trigger.workspaceId })
  const open = await db.ticket.count({
    where: {
      type: 'question',
      status: 'open',
      payload: { path: ['triggerId'], equals: trigger.id },
    },
  })
  if (!open)
    await db.ticket.create({
      data: {
        type: 'question',
        title: `Rule "${trigger.label}" could not take a mail: ${reason}. Give the rule to another teammate.`,
        payload: { triggerId: trigger.id, memberId: trigger.createdByMemberId },
      } as never,
    })
}
