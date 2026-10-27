// The API's outbox to runners: each command with a commandId (a message, a person's answer, a
// retry…) is a row before it is sent (RunnerCommand), mirroring the runner's own outbox of events
// (apps/runner/src/outbox.ts). It is still sent at once; the row is the safety net. The runner
// acknowledges it by id (OUTBOX_PROTOCOL), and what it has not acknowledged is sent again when it
// says hello, and every few minutes while it is connected; it ignores an id it has already seen.
// So an API restart, a cloud computer slow to start, or a connection that died before anyone
// noticed loses nothing. Nothing is dropped silently either: a command not through in 24 hours
// opens a ticket. A runner too old to acknowledge takes each command once, as before.
import { OUTBOX_PROTOCOL, type ApiToRunner } from '@brigade/contracts'
import { prisma, scoped } from './db.js'
import { noteFailure } from './ops/failures.js'

/** A command that names itself, so the runner can acknowledge it and ignore it the second time. */
export type DurableCommand = Extract<ApiToRunner, { commandId: string }>

export const isDurable = (message: ApiToRunner): message is DurableCommand =>
  'commandId' in message && typeof message.commandId === 'string'

/**
 * Commands moot after a while: a stop sent long after its turn may stop another, a browser window
 * opened for a person who left. Dropped, not reported, past this.
 */
const MOOT_AFTER_MS: Partial<Record<DurableCommand['type'], number>> = {
  'thread.interrupt': 10 * 60_000,
  'browser.open': 10 * 60_000,
}
/** Past this, a command that did not get through opens a ticket. */
export const GIVE_UP_MS = 24 * 60 * 60_000
/** Sent this long ago and not acknowledged: sent again to a runner that is connected. */
export const RESEND_MS = 2 * 60_000
/** Acknowledged commands are kept this long, then deleted. */
const KEEP_MS = 3 * 24 * 60 * 60_000

const sessionOf = (message: DurableCommand) =>
  'thread' in message ? message.thread.sessionId : 'sessionId' in message ? message.sessionId : null

/** Keep a command before it is sent. False when one with its id is kept already. */
export async function keepCommand(
  computer: { id: string; organizationId?: string; workspaceId?: string },
  message: DurableCommand,
) {
  const owner =
    computer.organizationId && computer.workspaceId
      ? { organizationId: computer.organizationId, workspaceId: computer.workspaceId }
      : await prisma.computer.findUniqueOrThrow({
          where: { id: computer.id },
          select: { organizationId: true, workspaceId: true },
        })
  try {
    await prisma.runnerCommand.create({
      data: {
        id: message.commandId,
        ...owner,
        computerId: computer.id,
        sessionId: sessionOf(message),
        type: message.type,
        message: message as never,
      },
    })
    return true
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') return false
    throw error
  }
}

/**
 * The command is on its way to a runner of this protocol: from OUTBOX_PROTOCOL on it stays
 * pending until acknowledged; an older runner never acknowledges, so it is done once sent.
 * False when it was already taken (sent to an older runner), so it is not sent twice.
 */
export async function noteSent(id: string, protocol: number) {
  const { count } = await prisma.runnerCommand.updateMany({
    where: { id, status: 'pending' },
    data: {
      ...(protocol >= OUTBOX_PROTOCOL ? {} : { status: 'acked' }),
      sentAt: new Date(),
      attempts: { increment: 1 },
    },
  })
  return count === 1
}

/** The runner acknowledged these commands: its own computer's only. */
export async function ackCommands(computerId: string, ids: string[]) {
  if (!ids.length) return
  await prisma.runnerCommand.updateMany({
    where: { id: { in: ids }, computerId, status: 'pending' },
    data: { status: 'acked' },
  })
}

/**
 * What a computer's runner has not acknowledged, oldest first; the moot ones are dropped. Without
 * their messages (commandMessage loads each as it goes): a thread.prompt carries its thread's
 * whole spec, near a megabyte with many connectors, and the dozens a stopped computer gathers,
 * read at once, took the API past its memory as the runner connected, which dropped every socket.
 */
export async function pendingCommands(computerId: string, now = Date.now()) {
  const rows = await prisma.runnerCommand.findMany({
    where: { computerId, status: 'pending' },
    orderBy: { createdAt: 'asc' },
    take: 500,
    select: { id: true, type: true, sentAt: true, createdAt: true },
  })
  const moot = rows.filter((r) => {
    const after = MOOT_AFTER_MS[r.type as DurableCommand['type']]
    return after !== undefined && now - r.createdAt.getTime() > after
  })
  if (moot.length)
    await prisma.runnerCommand.updateMany({
      where: { id: { in: moot.map((r) => r.id) }, status: 'pending' },
      data: { status: 'expired' },
    })
  return rows.filter((r) => !moot.includes(r)).map((r) => ({ id: r.id, sentAt: r.sentAt }))
}

/** A pending command's message, to send it; none once it is no longer pending. */
export async function commandMessage(id: string) {
  const row = await prisma.runnerCommand.findFirst({
    where: { id, status: 'pending' },
    select: { message: true },
  })
  return row ? (row.message as unknown as DurableCommand) : null
}

/** Computers with commands waiting, and since when: the minute's tick looks at each. */
export async function computersWaiting() {
  return prisma.runnerCommand.groupBy({
    by: ['computerId'],
    where: { status: 'pending' },
    _min: { createdAt: true, sentAt: true },
  })
}

/** What a thread's people read of a command that did not get through. */
const described = (message: DurableCommand) => {
  switch (message.type) {
    case 'thread.prompt':
      return message.memberId === null
        ? 'a message for the teammate (a wake-up, a report, an event)'
        : `a message: “${message.text.length > 120 ? `${message.text.slice(0, 117)}...` : message.text}”`
    case 'thread.approval':
      return `a decision on an approval (${message.approved ? 'approved' : 'denied'})`
    case 'thread.answer':
      return 'an answer to a question'
    case 'thread.ticket':
      return 'an answer to a ticket'
    case 'thread.retry':
      return 'a request to try the failed turn again'
    case 'thread.takeover':
      return 'a takeover'
    case 'thread.handback':
      return 'a hand-back'
    case 'thread.queued':
      return `a change to a queued message (${message.action})`
    default:
      return message.type
  }
}

/**
 * Commands not through in 24 hours: failed, and a ticket in each of their threads says what did
 * not go (once per thread while it is open). A thread left starting for one goes back to idle.
 */
export async function giveUp(now = Date.now()) {
  const old = await prisma.runnerCommand.findMany({
    where: { status: 'pending', createdAt: { lt: new Date(now - GIVE_UP_MS) } },
    orderBy: { createdAt: 'asc' },
    // Each with its message, up to a megabyte: a few at a time (pendingCommands).
    take: 20,
  })
  if (!old.length) return 0
  await prisma.runnerCommand.updateMany({
    where: { id: { in: old.map((r) => r.id) }, status: 'pending' },
    data: { status: 'failed' },
  })
  noteFailure('runner-commands', `${old.length} command(s) not through in 24 hours`)
  for (const [key, rows] of Map.groupBy(old, (r) => r.sessionId ?? `computer:${r.computerId}`)) {
    const first = rows[0]!
    const db = scoped({ organizationId: first.organizationId, workspaceId: first.workspaceId })
    const what = rows.map((r) => described(r.message as unknown as DurableCommand))
    const computer = await db.computer.findFirst({
      where: { id: first.computerId },
      select: { name: true, kind: true, memberId: true },
    })
    const where = computer?.name ?? 'its computer'
    if (!first.sessionId) {
      console.warn(`${key}: ${what.join('; ')} not through in 24 hours`)
      continue
    }
    const session = await db.session.findFirst({
      where: { id: first.sessionId },
      select: { id: true, status: true, startedByMemberId: true, lastSeq: true },
    })
    if (!session) continue
    if (session.status === 'starting')
      await db.session.updateMany({
        where: { id: session.id, status: 'starting' },
        data: { status: session.lastSeq > 0 ? 'idle' : 'failed' },
      })
    const open = await db.ticket.count({
      where: {
        sessionId: session.id,
        status: 'open',
        payload: { path: ['undelivered'], equals: true },
      },
    })
    if (open) continue
    await db.ticket.create({
      data: {
        sessionId: session.id,
        type: 'question',
        title:
          `Not delivered: ${what.slice(0, 3).join('; ')}${what.length > 3 ? ` and ${what.length - 3} more` : ''}. ` +
          `${where} did not take it in 24 hours; send it again once ${computer?.kind === 'cloud' ? 'it runs' : 'its runner is back'}.`,
        payload: {
          undelivered: true,
          memberId: session.startedByMemberId,
          commandIds: rows.map((r) => r.id),
        },
      } as never,
    })
  }
  return old.length
}

/** Commands acknowledged, failed or moot for a few days: deleted. */
export const sweepCommands = (now = Date.now()) =>
  prisma.runnerCommand.deleteMany({
    where: { status: { not: 'pending' }, updatedAt: { lt: new Date(now - KEEP_MS) } },
  })
