// The API's outbox to runners: each command with a commandId (a message, a person's answer, a
// retry…) is a row before it is sent (RunnerCommand), mirroring the runner's own outbox of events
// (apps/runner/src/outbox.ts). It is still sent at once; the row is the safety net. The runner
// acknowledges it by id (OUTBOX_PROTOCOL), and what it has not acknowledged is sent again when it
// says hello, and every few minutes while it is connected; it ignores an id it has already seen.
// So an API restart, a cloud computer slow to start, or a connection that died before anyone
// noticed loses nothing. Nothing is dropped silently either: a command not through in 24 hours
// opens a ticket. A runner too old to acknowledge takes each command once, as before.
import { OUTBOX_PROTOCOL, type ApiToRunner } from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { prisma, scoped } from './db.js'
import { noteFailure } from './ops/failures.js'
import { movedOf } from './thread-spec.js'

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

/**
 * At most this many commands wait for one computer, and for one of its threads: a computer that
 * stays down no longer gathers commands without end, each sent when it comes back (the
 * 2026-10-27 incident, docs/workspace-hubs-plan.md). Past either, a command is refused: a person
 * is told to try again once it runs, a trigger's event is offered again later by its source.
 */
export const PENDING_PER_COMPUTER = 200
export const PENDING_PER_THREAD = 20
/** Messages nobody typed (an event, a wake-up, a report): fewer of them wait for one computer. */
export const AUTOMATIC_PER_COMPUTER = 25

/** A message nobody typed: a trigger's event, a wake-up, a child's report. */
const automatic = (message: DurableCommand) =>
  message.type === 'thread.prompt' && message.memberId === null

/**
 * A message nobody typed that may go with the one before it: the same thread, the same teammate
 * answering, nothing else asked of it. While its computer is down, a thread's events wait as one
 * message rather than one turn each.
 */
const joinable = (
  message: DurableCommand,
): message is Extract<DurableCommand, { type: 'thread.prompt' }> =>
  automatic(message) &&
  message.type === 'thread.prompt' &&
  !message.then.length &&
  !message.handoff &&
  !message.steer &&
  !message.replyTo &&
  !message.nameThread

export type Kept = 'kept' | 'exists' | 'joined'

/**
 * Keep a command before it is sent: 'exists' when one with its id is kept already, 'joined' when
 * it went into a message of its thread waiting unsent (joinable). Throws a 503 past the caps.
 */
export async function keepCommand(
  computer: { id: string; organizationId?: string; workspaceId?: string },
  message: DurableCommand,
): Promise<Kept> {
  const owner =
    computer.organizationId && computer.workspaceId
      ? { organizationId: computer.organizationId, workspaceId: computer.workspaceId }
      : await prisma.computer.findUniqueOrThrow({
          where: { id: computer.id },
          select: { organizationId: true, workspaceId: true },
        })
  const sessionId = sessionOf(message)
  if (await prisma.runnerCommand.count({ where: { id: message.commandId } })) return 'exists'
  if (sessionId && joinable(message) && (await joinWaiting(computer.id, sessionId, message)))
    return 'joined'
  await checkCaps(computer.id, sessionId, message)
  try {
    await prisma.runnerCommand.create({
      data: {
        id: message.commandId,
        ...owner,
        computerId: computer.id,
        sessionId,
        type: message.type,
        message: message as never,
      },
    })
    return 'kept'
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') return 'exists'
    throw error
  }
}

/** Refuse a command past the caps on what waits for its computer and its thread. */
async function checkCaps(computerId: string, sessionId: string | null, message: DurableCommand) {
  const [forComputer, forThread, automaticOnes] = await Promise.all([
    prisma.runnerCommand.count({ where: { computerId, status: 'pending' } }),
    sessionId
      ? prisma.runnerCommand.count({ where: { computerId, sessionId, status: 'pending' } })
      : 0,
    automatic(message)
      ? prisma.$queryRaw<[{ count: bigint }]>`
          SELECT count(*) FROM "RunnerCommand"
          WHERE "computerId" = ${computerId} AND status = 'pending' AND type = 'thread.prompt'
            AND message->>'memberId' IS NULL`.then(([row]) => Number(row.count))
      : 0,
  ])
  const full =
    forComputer >= PENDING_PER_COMPUTER
      ? `${forComputer} commands already wait for its computer`
      : forThread >= PENDING_PER_THREAD
        ? `${forThread} commands already wait for this thread`
        : automaticOnes >= AUTOMATIC_PER_COMPUTER
          ? `${automaticOnes} messages from events, wake-ups and reports already wait for its computer`
          : null
  if (!full) return
  noteFailure('runner-outbox', `${message.type} for ${computerId} refused: ${full}`)
  throw new HTTPException(503, {
    message: `Not sent: ${full}. Try again once the computer runs.`,
  })
}

/**
 * Put an automatic message into the one of its thread that waits unsent, rather than keep a second
 * turn: its text after that one's, its files with them. Only while that one was never sent: the
 * update names its updatedAt, and sending claims it by setting sentAt (noteSent), so the two never
 * cross. Its id is kept on the message (joined), so a try after a restart is not joined twice.
 */
async function joinWaiting(
  computerId: string,
  sessionId: string,
  message: Extract<DurableCommand, { type: 'thread.prompt' }>,
) {
  const waiting = await prisma.runnerCommand.findFirst({
    where: { computerId, sessionId, status: 'pending', sentAt: null, type: 'thread.prompt' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, message: true, updatedAt: true },
  })
  const before = waiting?.message as (DurableCommand & { joined?: string[] }) | undefined
  if (!waiting || !before || !joinable(before)) return false
  if (before.thread.teammate.id !== message.thread.teammate.id) return false
  const joined: DurableCommand & { joined: string[] } = {
    ...before,
    text: `${before.text}\n\n${message.text}`,
    attachments: [...before.attachments, ...message.attachments],
    // The latest spec: it lists every file of the thread, these included.
    thread: message.thread,
    joined: [...(before.joined ?? []), message.commandId],
  }
  const { count } = await prisma.runnerCommand.updateMany({
    where: { id: waiting.id, status: 'pending', sentAt: null, updatedAt: waiting.updatedAt },
    data: { message: joined as never },
  })
  if (count)
    console.log(`command ${message.commandId} joined ${waiting.id}, waiting for its computer`)
  return count === 1
}

/** A command with this id is kept, alone or joined to another of its thread (joinWaiting). */
export async function isKept(id: string, sessionId: string | null) {
  const found = await prisma.runnerCommand.count({
    where: {
      OR: [
        { id },
        ...(sessionId ? [{ sessionId, message: { path: ['joined'], array_contains: [id] } }] : []),
      ],
    },
  })
  return found > 0
}

/**
 * The command is on its way to a runner of this protocol: from OUTBOX_PROTOCOL on it stays
 * pending until acknowledged; an older runner never acknowledges, so it is done once sent.
 * Its message as claimed, with what joined it until then (joinWaiting); null when it was already
 * taken (sent to an older runner), so it is not sent twice.
 */
export async function noteSent(id: string, protocol: number) {
  const [claimed] = await prisma.runnerCommand.updateManyAndReturn({
    where: { id, status: 'pending' },
    data: {
      ...(protocol >= OUTBOX_PROTOCOL ? {} : { status: 'acked' }),
      sentAt: new Date(),
      attempts: { increment: 1 },
    },
    select: { message: true },
  })
  return claimed ? (claimed.message as unknown as DurableCommand) : null
}

/** A claimed command that did not go after all (its spec could not be made whole): pending again. */
export async function unclaim(id: string) {
  await prisma.runnerCommand.updateMany({
    where: { id },
    data: { status: 'pending', sentAt: null },
  })
}

/**
 * A kept command as it goes now, its specs as of when it was kept. Null when it does not go:
 * its thread left this computer meanwhile (the command is expired). A thread that arrived again
 * on it since (its computer replaced, say) has its specs' arrival brought up to date: without
 * it the runner numbers the thread's events from its own count, and the API drops them.
 */
export async function asOfNow(computerId: string, message: DurableCommand) {
  if (!('thread' in message)) return message
  const session = await prisma.session.findUnique({
    where: { id: message.thread.sessionId },
    select: {
      computerId: true,
      movedAt: true,
      movedFrom: true,
      movedSeq: true,
      computer: { select: { kind: true, name: true } },
    },
  })
  if (session?.computerId !== computerId) {
    await prisma.runnerCommand.updateMany({
      where: { id: message.commandId, status: 'pending' },
      data: { status: 'expired' },
    })
    console.warn(`command ${message.commandId}: its thread left ${computerId}, not sent there`)
    return null
  }
  const moved = movedOf(session)
  if (!moved || message.thread.moved?.at === moved.at) return message
  if (message.type === 'thread.prompt')
    return {
      ...message,
      thread: { ...message.thread, moved },
      then: message.then.map((spec) => ({ ...spec, moved })),
    }
  return { ...message, thread: { ...message.thread, moved } }
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
export async function computersWaiting(workspaceId?: string) {
  return prisma.runnerCommand.groupBy({
    by: ['workspaceId', 'computerId'],
    where: { status: 'pending', ...(workspaceId ? { workspaceId } : {}) },
    _min: { createdAt: true, sentAt: true },
  })
}

/**
 * Each minute: each workspace's hub sends again what its connected runners have not acknowledged
 * and starts cloud computers that wait for commands (WorkspaceHub.resendCommands); then commands
 * not through in a day are given up, with a ticket. Started by the entry (src/jobs.ts).
 */
export async function resendCommands(now = Date.now(), workspaceId?: string) {
  const { hubs } = await import('./hub.js')
  const byWorkspace = Map.groupBy(await computersWaiting(workspaceId), (w) => w.workspaceId)
  for (const [workspaceId, waiting] of byWorkspace)
    await hubs
      .get(workspaceId)
      .resendCommands(
        waiting.map((w) => ({
          computerId: w.computerId,
          since: w._min.createdAt?.getTime() ?? now,
        })),
      )
      .catch((error) => {
        console.warn(`resending commands in ${workspaceId} failed: ${String(error)}`)
        noteFailure('job:runner-commands', error)
      })
  // Of every workspace: its own job when each workspace's run apart (src/jobs.ts).
  if (!workspaceId) await giveUp(now)
}

/** Workspaces with commands waiting for a computer (src/jobs.ts). */
export async function dueCommands() {
  return [...new Set((await computersWaiting()).map((w) => w.workspaceId))]
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
