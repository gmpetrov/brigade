// Chief's answers in the person's name (docs/chief-answers.md). Chief's daily pass
// (src/chief-pass.ts) answers the questions a person's rules settle: buttons or a choices card a
// teammate ended its reply on. An answer reaches the teammate as Brigade's note, a report's
// wake-up, in the very words a click sends, kept for the computer in order with the person's word
// (src/chief-order.ts). It is never the person's approval: the work done on its word, and what is
// handed on from it, asks them before App writes and credentials (onChiefsWord) until they write
// again. They may mark an answer wrong: its teammate stops and undoes what it can.
import {
  CHIEF_ANSWERS_IN_A_ROW,
  type ChiefDecisionStatus,
  type ChiefDecisionView,
  type ChiefOption,
  chiefAnswerMessage,
  chiefAnswerNote,
  chiefOverruledMessage,
  choiceMessage,
  OFFER_CHOICES_TOOL,
  safeChoices,
  safeReplies,
  SUGGEST_REPLIES_TOOL,
  bareToolName,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { audit } from './audit.js'
import { CHIEF_SOURCE, lockThread, questionClosed, withdrawAnswers } from './chief-order.js'
import { Prisma, scoped, type Scope, type ScopedDb } from './db.js'
import { hubs, threadUpdated } from './hub.js'
import { loadThread } from './thread-spec.js'

export const optionsOf = (value: unknown): ChiefOption[] =>
  Array.isArray(value)
    ? value.filter(
        (o): o is ChiefOption =>
          !!o && typeof o.label === 'string' && typeof o.message === 'string',
      )
    : []

/** Dashboards showing the thread read its decisions again. */
export async function threadChanged(scope: Scope, sessionId: string) {
  const row = await scoped(scope).session.findFirst({
    where: { id: sessionId },
    select: { status: true },
  })
  if (row) void hubs.get(scope.workspaceId).broadcast(threadUpdated(sessionId, row.status))
}

// ---------------------------------------------------------------------------
// The question a turn ended on
// ---------------------------------------------------------------------------

export type Ask = {
  seq: number
  teammateId: string
  options: ChiefOption[]
  /** The reply ending on it. */
  question: string
  /** What a choices card asks; buttons ask in the reply. */
  cardQuestion: string | null
}

/**
 * The buttons or choices card the thread's last turn ended on, while nobody answered it: after
 * the last message in the thread (a person's, or one Brigade wrote), in that turn, and not
 * dismissed. Its answers are what a click sends; a button that does Brigade's own action (merge,
 * preview) is never one of them.
 */
export async function openAsk(
  db: ScopedDb,
  thread: { id: string; teammateId: string; choicesDismissedSeq: number | null },
): Promise<Ask | null> {
  const [message, turn] = await Promise.all([
    db.sessionEvent.findFirst({
      where: { sessionId: thread.id, type: 'message.user' },
      orderBy: { seq: 'desc' },
      select: { seq: true },
    }),
    db.sessionEvent.findFirst({
      where: { sessionId: thread.id, type: 'turn.started' },
      orderBy: { seq: 'desc' },
      select: { seq: true, data: true },
    }),
  ])
  const after = Math.max(message?.seq ?? -1, turn?.seq ?? -1, thread.choicesDismissedSeq ?? -1)
  const cards = await db.sessionEvent.findMany({
    where: { sessionId: thread.id, type: 'tool.started', seq: { gt: after } },
    orderBy: { seq: 'desc' },
    take: 50,
    select: { seq: true, data: true },
  })
  for (const card of cards) {
    const data = card.data as { toolName?: string; input?: unknown }
    const tool = bareToolName(data.toolName ?? '')
    let options: ChiefOption[] = []
    let cardQuestion: string | null = null
    if (tool === OFFER_CHOICES_TOOL) {
      const choices = safeChoices(data.input)
      cardQuestion = choices?.question ?? null
      // What each option says of itself counts as much as its label ("Route A": deploy to production).
      options = (choices?.options ?? []).map((o) => ({
        label: o.label,
        message: choiceMessage(o),
        ...(o.description ? { description: o.description } : {}),
        ...(o.design ? { design: true } : {}),
      }))
    } else if (tool === SUGGEST_REPLIES_TOOL) {
      const replies = safeReplies(data.input)
      options = (replies?.replies ?? []).map((r) => ({ label: r, message: r }))
    } else continue
    if (!options.length) return null
    const reply = await db.sessionEvent.findFirst({
      where: { sessionId: thread.id, type: 'message.done', seq: { gt: after, lt: card.seq } },
      orderBy: { seq: 'desc' },
      select: { data: true },
    })
    return {
      seq: card.seq,
      teammateId: (turn?.data as { teammateId?: string } | null)?.teammateId ?? thread.teammateId,
      options,
      question: (reply?.data as { text?: string } | null)?.text ?? '',
      cardQuestion,
    }
  }
  return null
}

/** When the person last wrote in the thread, by their message's seq; -1 when they never did. */
async function lastPersonSeq(db: Pick<ScopedDb, 'sessionEvent'>, sessionId: string) {
  const rows = await db.sessionEvent.findMany({
    where: { sessionId, type: 'message.user' },
    orderBy: { seq: 'desc' },
    take: 100,
    select: { seq: true, data: true },
  })
  return rows.find((r) => (r.data as { memberId?: string | null }).memberId)?.seq ?? -1
}

/** Chief's answers that reached the thread since the person last wrote: CHIEF_ANSWERS_IN_A_ROW stops more. */
async function answersInARow(
  db: Pick<ScopedDb, 'sessionEvent' | 'chiefDecision'>,
  sessionId: string,
) {
  const since = await lastPersonSeq(db, sessionId)
  return db.chiefDecision.count({
    where: { sessionId, status: 'answered', askSeq: { gt: since } },
  })
}

// ---------------------------------------------------------------------------
// Chief answers
// ---------------------------------------------------------------------------

const chiefId = async (db: ScopedDb) =>
  (await db.teammate.findFirst({ where: { kind: 'chief' }, select: { id: true } }))?.id

/** A decision that sent nothing: #724's, still being made or only suggested. An answer settles it. */
export const UNSETTLED: ChiefDecisionStatus[] = ['pending', 'suggested']

/**
 * Answer a question in the person's name (a pass's chief_answer, src/chief-pass.ts). Kept as
 * Chief's decision on that card, once (a card answered already says how it stands), with where it
 * goes, in one transaction under the thread's lock, as the person's word is (src/chief-order.ts):
 * nowhere once the thread moved on; left to the person after CHIEF_ANSWERS_IN_A_ROW answers of
 * Chief's with no word from them; else to the teammate, as a report's wake-up, kept with it and
 * fired at once. Nothing at all once the person turned their pass off, or it is over: 'off'.
 */
export async function answerInTheirName(
  scope: Scope,
  input: {
    sessionId: string
    memberId: string
    teammateId: string
    askSeq: number
    options: ChiefOption[]
    cardQuestion: string | null
    /** The answer picked, from 0. */
    optionIndex: number
    reason: string
    /** The person's rule it goes by. */
    rule: string
    passId: string
  },
): Promise<{ decisionId: string | null; status: ChiefDecisionStatus | 'off'; again?: boolean }> {
  const db = scoped(scope)
  const kept = await db
    .$transaction(async (tx) => {
      await lockThread(tx, input.sessionId)
      // The person turning their pass off at this instant: whichever is kept first, the other
      // reads it, as setChief changes their row (then their passes), which this holds till kept.
      const [member] = await tx.$queryRaw<{ chiefPass: boolean }[]>`
        SELECT "chiefPass" FROM "Member"
        WHERE id = ${input.memberId} AND "organizationId" = ${scope.organizationId}
        FOR SHARE`
      const [pass] = await tx.$queryRaw<{ status: string }[]>`
        SELECT status::text AS status FROM "ChiefPass"
        WHERE id = ${input.passId} AND "workspaceId" = ${scope.workspaceId}
        FOR SHARE`
      if (!member?.chiefPass || pass?.status !== 'running') return null
      const existing = await tx.chiefDecision.findFirst({
        where: { sessionId: input.sessionId, askSeq: input.askSeq },
        select: { id: true, status: true },
      })
      // Answered already, by this pass or an earlier one: as it stands.
      if (existing && !UNSETTLED.includes(existing.status))
        return { decisionId: existing.id, status: existing.status, again: true as const }
      const option = input.options[input.optionIndex]
      const status: 'superseded' | 'escalated' | 'answered' = (await questionClosed(
        tx,
        input.sessionId,
        input.askSeq,
      ))
        ? 'superseded'
        : !option || (await answersInARow(tx, input.sessionId)) >= CHIEF_ANSWERS_IN_A_ROW
          ? 'escalated'
          : 'answered'
      const answer = {
        status,
        question: input.cardQuestion,
        options: input.options as unknown as Prisma.InputJsonValue,
        passId: input.passId,
        verdict: 'answer',
        optionIndex: input.optionIndex,
        reason: input.reason,
        basis: input.rule,
        decidedAt: new Date(),
      }
      const row = existing
        ? await tx.chiefDecision.update({
            where: { id: existing.id },
            data: answer as never,
            select: { id: true },
          })
        : await tx.chiefDecision.create({
            data: {
              sessionId: input.sessionId,
              memberId: input.memberId,
              teammateId: input.teammateId,
              askSeq: input.askSeq,
              ...answer,
            } as never,
            select: { id: true },
          })
      if (status !== 'answered' || !option) return { decisionId: row.id, status, wakeupId: null }
      // Its work goes on Chief's word from the question on, until the person writes after it.
      await raiseChiefsWord(tx, input.sessionId, input.askSeq)
      // As a report's wake-up: kept with the decision, tried until it reaches the thread.
      const wakeup = await tx.wakeup.create({
        data: {
          sessionId: input.sessionId,
          teammateId: input.teammateId,
          kind: 'report',
          note: chiefAnswerMessage({
            decisionId: row.id,
            answer: option.message,
            reason: input.reason,
            basis: input.rule,
          }),
          wakeAt: new Date(),
          sourceId: `${CHIEF_SOURCE}${row.id}`,
        } as never,
      })
      return { decisionId: row.id, status, wakeupId: wakeup.id }
    })
    .catch(async (error: unknown) => {
      // Kept at the same instant by a call that did not take the thread's lock: as it stands.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002')
        throw error
      const row = await db.chiefDecision.findFirst({
        where: { sessionId: input.sessionId, askSeq: input.askSeq },
        select: { id: true, status: true },
      })
      return { decisionId: row?.id ?? null, status: row?.status ?? 'failed', again: true as const }
    })
  if (!kept) return { decisionId: null, status: 'off' }
  if ('again' in kept) return kept
  await audit({
    ...scope,
    actor: { type: 'teammate', id: (await chiefId(db)) ?? 'chief' },
    action: `chief.${kept.status}`,
    target: { type: 'thread', id: input.sessionId },
    data: { decisionId: kept.decisionId, passId: input.passId, option: input.optionIndex },
  })
  if (kept.wakeupId) {
    const { fireNow } = await import('./wakeups.js')
    await fireNow(kept.wakeupId)
  }
  await threadChanged(scope, input.sessionId)
  return { decisionId: kept.decisionId, status: kept.status }
}

/**
 * A person dismissed a choices card without picking (POST /threads/:id/choices/dismiss): Chief's
 * decisions on it and before it are moot, an answer not delivered yet included.
 */
export async function noteChiefDismissed(scope: Scope, sessionId: string, seq: number) {
  const db = scoped(scope)
  const changed = await db.$transaction(async (tx) => {
    await lockThread(tx, sessionId)
    const { count } = await tx.chiefDecision.updateMany({
      where: { sessionId, askSeq: { lte: seq }, status: { in: ['pending', 'suggested'] } },
      data: { status: 'superseded' },
    })
    return count + (await withdrawAnswers(tx, sessionId, seq))
  })
  if (changed) await threadChanged(scope, sessionId)
}

// ---------------------------------------------------------------------------
// The person answers
// ---------------------------------------------------------------------------

/**
 * A thread's events are kept (src/hub/runner-messages.ts): in their order, an answer of Chief's
 * reaching the teammate puts the thread on Chief's word from there, and a person's message after
 * it lifts that. The questions before a person's message are answered: Chief's answers to them not
 * on their way never go, and those it is still making are moot. Hooks that run late change nothing
 * a later event decided.
 */
export async function noteChiefAnswered(
  session: { id: string; organizationId: string; workspaceId: string; parentId: string | null },
  events: { seq: number; event: { type: string; memberId?: string | null; text?: string } }[],
) {
  if (session.parentId) return
  const fromPerson = (e: (typeof events)[number]) =>
    (e.event.type === 'message.user' || e.event.type === 'message.queued') && !!e.event.memberId
  // What changes the mark, in the order the thread read it: Chief's answers, the person's words.
  const marks = events
    .filter(
      (e) =>
        e.event.type === 'message.user' &&
        (e.event.memberId || (e.event.text && chiefAnswerNote(e.event.text))),
    )
    .sort((a, b) => a.seq - b.seq)
  const message = events.find(fromPerson)
  if (!message && !marks.length) return
  const scope: Scope = { organizationId: session.organizationId, workspaceId: session.workspaceId }
  const db = scoped(scope)
  // Nothing of Chief's in the thread: nothing to settle (most threads, most messages).
  const involved = await db.session.count({
    where: {
      id: session.id,
      OR: [
        { chiefWordSeq: { not: null } },
        { chiefDecisions: { some: { status: { in: ['pending', 'answered'] } } } },
      ],
    },
  })
  if (!involved) return
  await db.$transaction(async (tx) => {
    await lockThread(tx, session.id)
    for (const e of marks)
      if (e.event.memberId) await lowerChiefsWord(tx, session.id, e.seq)
      else await raiseChiefsWord(tx, session.id, e.seq)
    if (!message) return
    // Their word came before an answer of Chief's went: that answer never goes. (Kept for the
    // computer, their word did that already: src/chief-order.ts.)
    await withdrawAnswers(tx, session.id, message.seq)
    await tx.chiefDecision.updateMany({
      where: { sessionId: session.id, askSeq: { lt: message.seq }, status: 'pending' },
      data: { status: 'superseded' },
    })
  })
  await threadChanged(scope, session.id)
}

/**
 * The person marks one of Chief's answers as wrong: the teammate is told to stop what it started
 * on it and undo what it can.
 */
export async function overruleDecision(
  scope: Scope & { memberId: string; role: string },
  sessionId: string,
  decisionId: string,
) {
  const db = scoped(scope)
  const decision = await db.chiefDecision.findFirst({
    where: { id: decisionId, sessionId, status: 'answered' },
  })
  if (!decision) throw new HTTPException(404, { message: 'No answer of Chief’s with that id here' })
  if (decision.memberId !== scope.memberId && scope.role !== 'owner' && scope.role !== 'admin')
    throw new HTTPException(403, {
      message: 'Only the person Chief answered for can mark it wrong',
    })
  if (decision.outcome === 'overruled') return { ok: true }
  await db.chiefDecision.updateMany({
    where: { id: decision.id },
    data: { outcome: 'overruled', outcomeAt: new Date() },
  })
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: 'chief.overruled',
    target: { type: 'thread', id: sessionId },
    data: { decisionId: decision.id, passId: decision.passId },
  })
  const option =
    decision.optionIndex != null ? optionsOf(decision.options)[decision.optionIndex] : undefined
  const thread = await loadThread(db, sessionId)
  const { promptThread } = await import('./work.js')
  await promptThread(
    db,
    scope,
    thread,
    {
      text: chiefOverruledMessage({ decisionId: decision.id, answer: option?.message ?? '' }),
      memberId: null,
      teammateIds: [decision.teammateId],
      // While it works on the answer, it hears it at its next step.
      ...(['running', 'starting'].includes(thread.status) ? { steer: true } : {}),
    },
    { commandId: `chief-wrong:${decision.id}` },
  ).catch((error: unknown) => console.warn(`chief: could not tell ${sessionId}: ${String(error)}`))
  await threadChanged(scope, sessionId)
  return { ok: true }
}

// ---------------------------------------------------------------------------
// What leaves Brigade waits for the person
// ---------------------------------------------------------------------------

/**
 * App writes that stay as the teammate's access says once Chief answered: work that can be undone
 * and leaves nothing outside (a branch, a pull request to review). Any other write asks the person.
 */
export const UNDOABLE_WRITES = new Set([
  'github_create_branch',
  'github_create_pull_request',
  'github_mark_ready_for_review',
])

/**
 * The thread's work goes on Chief's word (Session.chiefWordSeq): Chief answered there in its
 * person's name and they have not written since, or it was handed work while its giver did. Its
 * App writes then ask a person (src/connector-calls.ts), its credentials too (src/credentials.ts),
 * and it sets up no routine. The work it hands on carries the mark (markOnChiefsWord).
 */
export const onChiefsWord = (session: { chiefWordSeq: number | null }) =>
  session.chiefWordSeq !== null

/**
 * The thread goes on Chief's word from event `seq` on, or from a later one it already does: only
 * a person's message after it lifts it (lowerChiefsWord), whatever order the hooks run in.
 */
async function raiseChiefsWord(tx: Pick<ScopedDb, '$executeRaw'>, sessionId: string, seq: number) {
  await tx.$executeRaw`
    UPDATE "Session" SET "chiefWordSeq" = GREATEST(COALESCE("chiefWordSeq", -1), ${seq})
    WHERE id = ${sessionId}`
}

/** The person's message `seq` reached the thread: Chief's word before it no longer holds. */
async function lowerChiefsWord(tx: Pick<ScopedDb, '$executeRaw'>, sessionId: string, seq: number) {
  await tx.$executeRaw`
    UPDATE "Session" SET "chiefWordSeq" = NULL
    WHERE id = ${sessionId} AND "chiefWordSeq" < ${seq}`
}

/**
 * A thread on Chief's word hands work on to another (a message, a task given to its thread): that
 * thread goes on it too, from its latest event on, until a person writes there.
 */
export async function markOnChiefsWord(
  db: ScopedDb,
  sessionId: string,
  from: { chiefWordSeq: number | null },
) {
  if (from.chiefWordSeq === null) return
  await db.$executeRaw`
    UPDATE "Session" s SET "chiefWordSeq" = GREATEST(
      COALESCE(s."chiefWordSeq", -1),
      COALESCE((SELECT max(e.seq) FROM "SessionEvent" e WHERE e."sessionId" = s.id), 0))
    WHERE s.id = ${sessionId}`
}

// ---------------------------------------------------------------------------
// What threads show
// ---------------------------------------------------------------------------

/** A thread's answers of Chief's, as its view shows them beside their notes. */
export async function threadDecisions(
  db: ScopedDb,
  sessionId: string,
): Promise<ChiefDecisionView[]> {
  const rows = await db.chiefDecision.findMany({
    where: { sessionId },
    orderBy: { askSeq: 'asc' },
  })
  return rows.map((r) => ({
    id: r.id,
    askSeq: r.askSeq,
    status: r.status,
    option: r.optionIndex != null ? (optionsOf(r.options)[r.optionIndex] ?? null) : null,
    reason: r.reason,
    basis: r.basis,
    outcome: r.outcome,
    createdAt: r.createdAt.toISOString(),
  }))
}
