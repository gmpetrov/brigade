// Chief's answers and the person's word, in the order the thread reads them (docs/chief-answers.md).
// Both reach the thread's computer as commands kept before they are sent (src/runner-commands.ts):
// an answer of Chief's as its wake-up's prompt; the person's word as their message, or as they take
// the thread in hand or hand it back. Which one the thread reads first is settled as each is kept,
// in the transaction that keeps it, under the thread's lock (keepInOrder): the person's word
// withdraws every answer of Chief's that has not gone to the computer, and an answer of Chief's is
// kept only while its question is open, nobody has the thread in hand, and no word of the person's
// waits to be read before it. The workspace's hub then keeps and sends these commands of one thread
// one at a time (WorkspaceHub.dispatch), so its computer gets them in the order they were kept.
import { randomUUID } from 'node:crypto'
import { chiefAnswerNote, type ApiToRunner } from '@brigade/contracts'
import { prisma, type Prisma, type ScopedDb } from './db.js'

type Tx = Prisma.TransactionClient
/** A client, or a transaction's, scoped to a workspace (src/db.ts) or not: these filter by thread. */
type Client<K extends keyof Tx & keyof ScopedDb> = Pick<Tx, K> | Pick<ScopedDb, K>

/** An answer of Chief's for the person, as its wake-up's sourceId: `chief:<decision>`. */
export const CHIEF_SOURCE = 'chief:'

const WAKEUP_COMMAND = 'wakeup:'
/** A wake-up's prompt, by its commandId (src/wakeups.ts): the same on every try. */
export const wakeupCommandId = (wakeupId: string) => `${WAKEUP_COMMAND}${wakeupId}`

/** One thread's decisions, one change at a time: a command kept, a decision, a dismissal. */
export const lockThread = (tx: Pick<Tx, '$executeRaw'>, sessionId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`chief:${sessionId}`}, 0))`

/**
 * The question is no longer open: a message came in the thread after it (a person answered it,
 * or Brigade moved the thread on), or a person dismissed its card without picking.
 */
export async function questionClosed(
  client: Client<'sessionEvent' | 'session'>,
  sessionId: string,
  seq: number,
) {
  const db = client as Pick<Tx, 'sessionEvent' | 'session'>
  const after = await db.sessionEvent.count({
    where: { sessionId, type: { in: ['message.user', 'message.queued'] }, seq: { gt: seq } },
  })
  if (after) return true
  const thread = await db.session.findFirst({
    where: { id: sessionId },
    select: { choicesDismissedSeq: true },
  })
  return (thread?.choicesDismissedSeq ?? -1) >= seq
}

/**
 * How a command bears on Chief's answers: the person's word (their message; taking the thread in
 * hand or handing it back), or an answer of Chief's (its wake-up's prompt), by its decision.
 */
export type ChiefGate = { person: true } | { answer: string }

export function chiefGateOf(message: ApiToRunner): ChiefGate | null {
  if (message.type === 'thread.takeover' || message.type === 'thread.handback')
    return { person: true }
  if (message.type !== 'thread.prompt') return null
  if (message.memberId) return { person: true }
  if (!message.commandId.startsWith(WAKEUP_COMMAND)) return null
  const note = chiefAnswerNote(message.text)
  return note ? { answer: note.decisionId } : null
}

/**
 * Chief's answers on questions up to `upTo` (every one when null) that have not gone to the
 * thread's computer: the person's word, or their dismissal, came first. One not kept yet never is
 * (its wake-up is cancelled); one kept while the computer was away, and not sent since, is
 * withdrawn. Each is superseded. One sent already stays: the computer reads it first.
 */
export async function withdrawAnswers(
  client: Client<'chiefDecision' | 'wakeup' | 'runnerCommand'>,
  sessionId: string,
  upTo: number | null,
) {
  const tx = client as Pick<Tx, 'chiefDecision' | 'wakeup' | 'runnerCommand'>
  const within = upTo === null ? {} : { askSeq: { lte: upTo } }
  let withdrawn = 0
  const unkept = await tx.chiefDecision.findMany({
    where: { sessionId, status: 'answered', sentAt: null, ...within },
    select: { id: true },
  })
  for (const d of unkept) {
    await tx.wakeup.updateMany({
      where: { sessionId, sourceId: `${CHIEF_SOURCE}${d.id}`, status: 'pending' },
      data: { status: 'cancelled' },
    })
    const { count } = await tx.chiefDecision.updateMany({
      where: { id: d.id, status: 'answered', sentAt: null },
      data: { status: 'superseded' },
    })
    withdrawn += count
  }
  const unsent = await tx.runnerCommand.findMany({
    where: { sessionId, status: 'pending', sentAt: null, id: { startsWith: WAKEUP_COMMAND } },
    select: { id: true },
  })
  if (!unsent.length) return withdrawn
  const wakeups = await tx.wakeup.findMany({
    where: {
      sessionId,
      id: { in: unsent.map((c) => c.id.slice(WAKEUP_COMMAND.length)) },
      sourceId: { startsWith: CHIEF_SOURCE },
    },
    select: { id: true, sourceId: true },
  })
  for (const w of wakeups) {
    const decision = await tx.chiefDecision.findFirst({
      where: {
        id: w.sourceId!.slice(CHIEF_SOURCE.length),
        sessionId,
        status: 'answered',
        ...within,
      },
      select: { id: true },
    })
    if (!decision) continue
    const { count } = await tx.runnerCommand.updateMany({
      where: { id: wakeupCommandId(w.id), status: 'pending', sentAt: null },
      data: { status: 'expired' },
    })
    if (!count) continue
    await tx.chiefDecision.updateMany({
      where: { id: decision.id, status: 'answered' },
      data: { status: 'superseded' },
    })
    withdrawn++
  }
  return withdrawn
}

/** A command not through in a day fails (runner-commands.ts, GIVE_UP_MS): no answer waits longer. */
const DAY_MS = 24 * 60 * 60_000

/**
 * Whether the person's word has anything of Chief's to settle in the thread: a decision being
 * made, or an answer that may not have gone to the computer yet. Most threads have none (Chief
 * off, or never asked there): their person's word is kept as any command is. One decided just
 * after this reads is kept after their word, which it waits for (answerMayGo).
 */
export async function chiefOpenIn(sessionId: string) {
  const since = new Date(Date.now() - DAY_MS)
  const open = await prisma.chiefDecision.count({
    where: {
      sessionId,
      OR: [
        { status: 'pending' },
        { status: 'answered', OR: [{ sentAt: null }, { sentAt: { gt: since } }] },
      ],
    },
  })
  return open > 0
}

/** A word of the person's kept for the thread's computer and not taken there yet: read first. */
async function personWordWaiting(tx: Pick<Tx, '$queryRaw'>, computerId: string, sessionId: string) {
  const [row] = await tx.$queryRaw<[{ count: bigint }]>`
    SELECT count(*) FROM "RunnerCommand"
    WHERE "computerId" = ${computerId} AND status = 'pending' AND "sessionId" = ${sessionId}
      AND (type IN ('thread.takeover', 'thread.handback')
        OR (type = 'thread.prompt' AND message->>'memberId' IS NOT NULL))`
  return Number(row.count) > 0
}

/**
 * Whether an answer of Chief's may be kept for the thread's computer now: its decision answered
 * and not kept yet, its question open, nobody with the thread in hand, and no word of the
 * person's waiting to be read before it. One that may not never goes: superseded, its wake-up
 * cancelled.
 */
async function answerMayGo(tx: Tx, computerId: string, sessionId: string, decisionId: string) {
  const decision = await tx.chiefDecision.findFirst({
    where: { id: decisionId, sessionId },
    select: { status: true, askSeq: true, sentAt: true },
  })
  if (decision?.status !== 'answered' || decision.sentAt) return { go: false, settled: 0 }
  const thread = await tx.session.findFirst({
    where: { id: sessionId },
    select: { controlledByMemberId: true },
  })
  const moot =
    !thread ||
    !!thread.controlledByMemberId ||
    (await questionClosed(tx, sessionId, decision.askSeq)) ||
    (await personWordWaiting(tx, computerId, sessionId))
  if (moot) {
    await tx.wakeup.updateMany({
      where: { sessionId, sourceId: `${CHIEF_SOURCE}${decisionId}`, status: 'pending' },
      data: { status: 'cancelled' },
    })
    const { count } = await tx.chiefDecision.updateMany({
      where: { id: decisionId, status: 'answered', sentAt: null },
      data: { status: 'superseded' },
    })
    return { go: false, settled: count }
  }
  await tx.chiefDecision.updateMany({
    where: { id: decisionId, status: 'answered', sentAt: null },
    data: { sentAt: new Date() },
  })
  return { go: true, settled: 0 }
}

/**
 * Keep a command that bears on Chief's answers (chiefGateOf), in the transaction that settles
 * which the thread reads first, under its lock. The person's word supersedes Chief's decisions
 * still being made and withdraws its answers not gone; an answer of Chief's that may not go is
 * 'moot', and not kept. Kept after the thread's commands still waiting, never at the same instant,
 * so a computer that comes back gets them in this order too (pendingCommands).
 */
export async function keepInOrder(
  command: {
    id: string
    organizationId: string
    workspaceId: string
    computerId: string
    sessionId: string
  },
  gate: ChiefGate,
  keep: (tx: Tx, createdAt: Date) => Promise<unknown>,
): Promise<'kept' | 'exists' | 'moot'> {
  const { computerId, sessionId } = command
  const { outcome, settled } = await prisma.$transaction(async (tx) => {
    await lockThread(tx, sessionId)
    if (await tx.runnerCommand.count({ where: { id: command.id } }))
      return { outcome: 'exists' as const, settled: 0 }
    let settled = 0
    if ('answer' in gate) {
      const order = await answerMayGo(tx, computerId, sessionId, gate.answer)
      if (!order.go) return { outcome: 'moot' as const, settled: order.settled }
    } else {
      const { count } = await tx.chiefDecision.updateMany({
        where: { sessionId, status: 'pending' },
        data: { status: 'superseded' },
      })
      settled = count + (await withdrawAnswers(tx, sessionId, null))
    }
    const last = await tx.runnerCommand.findFirst({
      where: { computerId, sessionId, status: 'pending' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    })
    await keep(tx, new Date(Math.max(Date.now(), (last?.createdAt.getTime() ?? 0) + 1)))
    return { outcome: 'kept' as const, settled }
  })
  if (settled) {
    // Dashboards showing the thread read its decisions again.
    const { hubs, threadUpdated } = await import('./hub.js')
    const row = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { status: true },
    })
    if (row) void hubs.get(command.workspaceId).broadcast(threadUpdated(sessionId, row.status))
  }
  return outcome
}

/** A retry Chief's pass sends in the person's name (chief_retry), by its commandId. */
const PASS_RETRY = 'chief-retry:'
export const passRetryCommandId = (passId: string) => `${PASS_RETRY}${passId}:${randomUUID()}`
/** The pass a command is a retry of (passRetryCommandId), or null. */
export const passOfCommand = (commandId: string) =>
  commandId.startsWith(PASS_RETRY) ? commandId.slice(PASS_RETRY.length).split(':')[0] || null : null

/**
 * Keep a retry Chief's pass sends in the person's name only while their pass is on and at work,
 * under their row's lock as an answer is (answerInTheirName): kept before they turn it off
 * (setChief changes their row, then marks their passes over), or never ('moot').
 */
export async function keepForPass(
  row: Prisma.RunnerCommandUncheckedCreateInput & { workspaceId: string },
  passId: string,
): Promise<'kept' | 'moot'> {
  return prisma.$transaction(async (tx) => {
    const [pass] = await tx.$queryRaw<{ memberId: string }[]>`
      SELECT "memberId" FROM "ChiefPass" WHERE id = ${passId} AND "workspaceId" = ${row.workspaceId}`
    if (!pass) return 'moot'
    // Their row first, then the pass, as setChief changes them.
    const [member] = await tx.$queryRaw<{ chiefPass: boolean }[]>`
      SELECT "chiefPass" FROM "Member" WHERE id = ${pass.memberId} FOR SHARE`
    const [now] = await tx.$queryRaw<{ status: string }[]>`
      SELECT status::text AS status FROM "ChiefPass" WHERE id = ${passId} FOR SHARE`
    if (!member?.chiefPass || now?.status !== 'running') return 'moot'
    await tx.runnerCommand.create({ data: row })
    return 'kept'
  })
}
