// Calls that wait for a person's decision: an App's write that asks (src/connector-calls.ts), a
// credential (src/credentials.ts), a trigger (src/trigger-calls.ts). Each is a row (HeldCall) with
// its ticket, not a promise in this process: the API restarts with each deploy and a runner's
// connection drops, so a decision may come when nothing waits for it any more. Whenever it comes,
// the call is made once, and its result goes to the teammate's tool while that still waits on
// this connection, else to its thread as a message (a wake-up, as an email's reply does). An
// identical call meanwhile (same thread, teammate, tool and arguments) joins the open ticket
// rather than open a second one, so approving never makes it twice.
import { createHash } from 'node:crypto'
import type { ApiToRunner } from '@brigade/contracts'
import { prisma, scoped, type Scope, type ScopedDb } from './db.js'
import { noteFailure } from './ops/failures.js'
import { fireNow } from './wakeups.js'

/**
 * A person's decision. always: a credential's ticket, also allowed for good (see credentials.ts).
 * input: what the person changed before approving (an email's draft), for an operation that lets them.
 */
export type Decision = {
  approved: boolean
  memberId: string
  reason?: string
  always?: boolean
  input?: Record<string, unknown>
}

export type HeldKind = 'connector' | 'credential' | 'trigger'

/** Making a held call once its decision came: the decision, and whether a tool still waits for it. */
export type Resume = {
  decision: Decision & { ticketId: string }
  /** Nothing waits on a connection: the result goes to the thread as a message. */
  detached: boolean
}

type Result = Extract<ApiToRunner, { type: 'connector.result' }>
type Reply = (message: ApiToRunner) => void

/** Where a runner's call waits: its connection, while it is the computer's current one. */
export type Live = { reply: Reply; alive: () => boolean }
const always: Live['alive'] = () => true

/** A tool waiting in this process for a held call's result, by its ticket. */
type Waiter = { callId: string; live: Live; settle: () => void }
const waiters = new Map<string, Waiter[]>()

/** A decided call left this long is made by the minute's tick (the API restarted meanwhile). */
const DECIDED_GRACE_MS = 60_000
/** A call being made this long was cut off by a restart: it is not made again. */
const RUNNING_STALE_MS = 10 * 60_000
/** Finished calls are kept this long, then deleted. */
const KEEP_MS = 7 * 24 * 60 * 60_000
/** The most of a result a thread's message quotes. */
const OUTPUT_MAX = 6000

/** Same thread, teammate, tool and arguments: the same call. Object keys in any order. */
export function fingerprintOf(kind: HeldKind, teammateId: string, request: unknown) {
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
              .filter(([, v]) => v !== undefined)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, v]) => [k, stable(v)]),
          )
        : value
  return createHash('sha256')
    .update(JSON.stringify([kind, teammateId, stable(request)]))
    .digest('hex')
}

const isUnique = (error: unknown) => (error as { code?: string })?.code === 'P2002'

/**
 * Hold a call for a person's decision: join the open ticket of an identical call in the thread,
 * or open one with the call kept beside it. Tells the runner the call waits (connector.pending),
 * then resolves once its result went to this tool, or once nothing waits for it here any more.
 */
export async function holdCall(
  db: ScopedDb,
  hold: {
    kind: HeldKind
    sessionId: string
    teammateId: string
    callId: string
    /** What makes two calls the same (the arguments as the teammate gave them). */
    same: unknown
    /** The call as kept to be made later; only built for a new ticket (it may seal a secret). */
    request: () => Promise<object> | object
    /** A kept request that was not used after all (another call took the ticket first). */
    discard?: (request: object) => Promise<unknown>
    ticket: { type: 'approval' | 'cap'; title: string; payload: object }
    pending: { target: string; reason?: string; always?: boolean }
    live?: Live
    /** Once the ticket is open, before the runner hears (a cap's audit). */
    opened?: (ticketId: string) => Promise<unknown>
  },
): Promise<{ ticketId: string; joined: boolean }> {
  const fingerprint = fingerprintOf(hold.kind, hold.teammateId, hold.same)
  const open = async () => {
    const found = await db.heldCall.findFirst({
      where: { sessionId: hold.sessionId, fingerprint, status: 'waiting' },
    })
    if (!found) return null
    const ticket = await db.ticket.count({ where: { id: found.ticketId, status: 'open' } })
    if (ticket) return found.ticketId
    // Its ticket closed some other way: it waits for nothing now.
    await db.heldCall.updateMany({
      where: { id: found.id, status: 'waiting' },
      data: { status: 'expired' },
    })
    return null
  }
  let ticketId = await open()
  const joined = Boolean(ticketId)
  if (!ticketId) {
    const request = await hold.request()
    try {
      ticketId = await db.$transaction(async (tx) => {
        const ticket = await tx.ticket.create({
          data: {
            sessionId: hold.sessionId,
            type: hold.ticket.type,
            title: hold.ticket.title,
            payload: hold.ticket.payload,
          } as never,
        })
        await tx.heldCall.create({
          data: {
            sessionId: hold.sessionId,
            teammateId: hold.teammateId,
            ticketId: ticket.id,
            kind: hold.kind,
            fingerprint,
            request,
          } as never,
        })
        return ticket.id
      })
    } catch (error) {
      // The same call at the same time: the other one opened the ticket.
      if (!isUnique(error)) throw error
      await hold.discard?.(request)
      ticketId = await open()
      if (!ticketId) throw error
    }
    await hold.opened?.(ticketId)
  }
  const live = hold.live ?? { reply: () => undefined, alive: always }
  live.reply({
    type: 'connector.pending',
    callId: hold.callId,
    ticketId: ticketId!,
    target: hold.pending.target,
    ...(hold.pending.reason ? { reason: hold.pending.reason } : {}),
    ...(hold.pending.always ? { always: true } : {}),
  })
  await new Promise<void>((settle) => {
    const list = waiters.get(ticketId!) ?? []
    list.push({ callId: hold.callId, live, settle })
    waiters.set(ticketId!, list)
  })
  return { ticketId: ticketId!, joined: Boolean(joined) }
}

/**
 * Take a person's decision on a held call's ticket, once. False when no call waits on it (a
 * ticket from before held calls, or decided already). The call is made right after, and the
 * returned promise ends once its result went where it goes.
 */
export async function decideHeld(db: ScopedDb, ticketId: string, decision: Decision) {
  const held = await db.heldCall.findFirst({ where: { ticketId, status: 'waiting' } })
  if (!held) return null
  const { count } = await db.heldCall.updateMany({
    where: { id: held.id, status: 'waiting' },
    data: { status: 'decided', decision: decision as never },
  })
  if (!count) return null
  return { run: () => runHeld(held.id) }
}

type Executor = (
  runner: { computerId: string; organizationId: string; workspaceId: string },
  request: Record<string, unknown> & { callId: string },
  reply: Reply,
  resume: Resume,
) => Promise<unknown>
const executors = new Map<HeldKind, Executor>()

/** How each kind of call is made once decided: registered by its module, as it loads. */
export function onDecided(kind: HeldKind, executor: Executor) {
  executors.set(kind, executor)
}

/** The waiters of a ticket that can still hear, and settle the others. */
function liveWaiters(ticketId: string) {
  const list = waiters.get(ticketId) ?? []
  const live = list.filter((w) => w.live.alive())
  for (const w of list) if (!live.includes(w)) w.settle()
  if (live.length) waiters.set(ticketId, live)
  else waiters.delete(ticketId)
  return live
}

/** Tools whose connection closed stop waiting here (src/hub.ts, when a runner leaves). */
export function dropDeadWaiters() {
  for (const ticketId of [...waiters.keys()]) liveWaiters(ticketId)
}

/** As an API restart leaves them: no tool waits in this process. For tests. */
export function forgetWaiters() {
  for (const list of waiters.values()) for (const w of list) w.settle()
  waiters.clear()
}

/** Make a decided call, once: claimed, made, and its result delivered. */
export async function runHeld(id: string) {
  const { count } = await prisma.heldCall.updateMany({
    where: { id, status: 'decided' },
    data: { status: 'running' },
  })
  if (!count) return
  const held = await prisma.heldCall.findUniqueOrThrow({ where: { id } })
  const scope: Scope = { organizationId: held.organizationId, workspaceId: held.workspaceId }
  const db = scoped(scope)
  const decision = { ...(held.decision as Decision), ticketId: held.ticketId }
  let result: Result | undefined
  const live = liveWaiters(held.ticketId)
  try {
    const session = await db.session.findFirst({
      where: { id: held.sessionId },
      select: { computerId: true },
    })
    const execute = executors.get(held.kind as HeldKind)
    if (!session) result = failed('The thread is gone')
    else if (!execute) result = failed(`Brigade cannot make a ${held.kind} call`)
    else
      await execute(
        { computerId: session.computerId, ...scope },
        { ...(held.request as Record<string, unknown>), callId: live[0]?.callId ?? held.id },
        (message) => {
          if (message.type === 'connector.result') result = message
        },
        { decision, detached: live.length === 0 },
      )
  } catch (error) {
    result = failed(error instanceof Error ? error.message : String(error))
  }
  result ??= failed('The call gave no result')
  // The tools still waiting on their connection hear it; else the thread does, as a message.
  const heard = liveWaiters(held.ticketId)
  for (const w of heard) w.live.reply({ ...result, callId: w.callId })
  for (const w of heard) w.settle()
  waiters.delete(held.ticketId)
  if (!heard.length) await tellThread(db, held, decision, result)
  await db.heldCall.updateMany({
    where: { id: held.id },
    data: {
      status: 'done',
      result: {
        ok: result.ok,
        ...(result.error ? { error: result.error.slice(0, 1000) } : {}),
        heard: heard.length ? 'live' : 'thread',
      },
    },
  })
}

const failed = (error: string): Result => ({
  type: 'connector.result',
  callId: '',
  ok: false,
  error,
})

const quote = (value: unknown) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1)
  return text.length > OUTPUT_MAX ? `${text.slice(0, OUTPUT_MAX)}\n[… cut]` : text
}

/** What the thread is told of a held call it no longer waited for. */
function messageFor(title: string, decision: Decision, result: Result, note?: string): string {
  const who = decision.approved ? 'approved' : 'denied'
  const head = `A person ${who} what you asked for earlier, "${title}", after your call stopped waiting for it.`
  if (!decision.approved)
    return `${head}${decision.reason ? ` Their reason: ${decision.reason}` : ''}\nIt was not done. Do not ask again unless the person says so.`
  if (note) return `${head}\n${note}`
  if (!result.ok)
    return `${head}\nBrigade made the call, and it failed: ${result.error ?? 'no reason given'}`
  return `${head}\nBrigade made the call once; do not make it again. Its result:\n${quote(result.output ?? null)}`
}

/** The thread hears the result: a wake-up for the teammate that asked, fired now. */
async function tellThread(
  db: ScopedDb,
  held: { id: string; sessionId: string; teammateId: string; ticketId: string },
  decision: Decision,
  result: Result,
) {
  const ticket = await db.ticket.findFirst({
    where: { id: held.ticketId },
    select: { title: true },
  })
  const output = result.output as
    { note?: unknown; detached?: boolean; secret?: unknown } | undefined
  const text = messageFor(
    ticket?.title ?? 'a call',
    decision,
    result,
    // A detached call says itself what the teammate does next (a credential: use it again). A
    // released secret is never written in a message.
    output?.detached && typeof output.note === 'string'
      ? output.note
      : output && 'secret' in output
        ? 'It is allowed in this thread now: call the same tool again to use it.'
        : undefined,
  )
  const wakeup = await db.wakeup
    .create({
      data: {
        sessionId: held.sessionId,
        teammateId: held.teammateId,
        kind: 'reply',
        note: text,
        wakeAt: new Date(),
        sourceId: `held:${held.ticketId}`,
      } as never,
    })
    .catch((error) => {
      if (isUnique(error)) return null
      throw error
    })
  if (wakeup) await fireNow(wakeup.id)
}

let ticking = false

/**
 * Each minute: calls decided while the API restarted are made; calls a restart cut off while they
 * were being made are not made again, and their thread is told so; finished ones go after a week.
 */
export async function settleHeldCalls(now = Date.now()) {
  if (ticking) return
  ticking = true
  try {
    const decided = await prisma.heldCall.findMany({
      where: { status: 'decided', updatedAt: { lt: new Date(now - DECIDED_GRACE_MS) } },
      select: { id: true },
      take: 50,
    })
    for (const { id } of decided)
      await runHeld(id).catch((error) => {
        console.error(`held call ${id} failed`, error)
        noteFailure('held-calls', error)
      })
    const cut = await prisma.heldCall.findMany({
      where: { status: 'running', updatedAt: { lt: new Date(now - RUNNING_STALE_MS) } },
      take: 50,
    })
    for (const held of cut) {
      const { count } = await prisma.heldCall.updateMany({
        where: { id: held.id, status: 'running', updatedAt: held.updatedAt },
        data: { status: 'done', result: { ok: false, error: 'cut off by a restart' } },
      })
      if (!count) continue
      const db = scoped({ organizationId: held.organizationId, workspaceId: held.workspaceId })
      await tellThread(
        db,
        held,
        { ...(held.decision as Decision) },
        failed(
          'Brigade restarted while making it, so it may or may not have gone through. Check before you make it again.',
        ),
      ).catch((error) => console.error(`held call ${held.id}: thread not told`, error))
    }
    await prisma.heldCall.deleteMany({
      where: { status: { in: ['done', 'expired'] }, updatedAt: { lt: new Date(now - KEEP_MS) } },
    })
  } finally {
    ticking = false
  }
}
