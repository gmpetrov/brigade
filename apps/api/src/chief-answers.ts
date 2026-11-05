// Chief answers for the person (docs/chief-answers.md). When a teammate's turn ends on buttons or
// a choices card in a thread of a member who lets Chief answer for them, Brigade starts a
// sub-thread of Chief's with a brief of its own (the question, what it offers, the person's
// request and mandate). Chief decides with chief_decide: an answer or a "not now" in the person's
// name, or the question left to them. Then, by the kind of question and what the person allowed:
// its answer reaches the teammate on its own (a Brigade note, as a wake-up's), or it shows on the
// question as Chief's suggestion for the person to take or not. The person's own answers measure
// how often they agree; once they agree enough on a kind, a ticket offers to let Chief answer that
// kind on its own. Chief's answer is never the person's approval: the work done on its word, and
// what is handed on from it, asks them before App writes and credentials (onChiefsWord).
//
// A member with it off gets nothing of this: no decision starts, the spec says nothing of Chief's
// answers, and the thread waits on them as before.
import { randomUUID } from 'node:crypto'
import {
  CHIEF_ANSWERS_IN_A_ROW,
  CHIEF_KIND_LABELS,
  CHIEF_KINDS,
  CHIEF_PROMOTION,
  CHIEF_PROTOCOL,
  type ChiefDecisionView,
  type ChiefKind,
  type ChiefOperation,
  type ChiefOption,
  ChiefQuestionKind,
  chiefAnswerMessage,
  chiefAnswerNote,
  chiefDecisionBrief,
  chiefOverruledMessage,
  choiceMessage,
  MANDATE_PATH,
  OFFER_CHOICES_TOOL,
  PARKED_PATH,
  pickedChoice,
  safeChoices,
  safeReplies,
  SUGGEST_REPLIES_TOOL,
  bareToolName,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { audit } from './audit.js'
import { CHIEF_SOURCE, lockThread, questionClosed, withdrawAnswers } from './chief-order.js'
import { prisma, Prisma, scoped, type Scope, type ScopedDb } from './db.js'
import { hubs, threadUpdated } from './hub.js'
import { documentText } from './library.js'
import { teammateLibraryAccess } from './library-folders.js'
import { askedBy, loadThread, type LoadedThread } from './thread-spec.js'

/** A decision Chief has not made in this long is given up: the question is the person's. */
export const DECISION_MINUTES = 15
/** What of a teammate's reply, and of the person's request, a brief keeps: their ends. */
const QUESTION_CHARS = 6_000
const REQUEST_CHARS = 3_000
const MANDATE_CHARS = 8_000

/** The kinds Chief may answer, from what a call or a row says. */
const isKind = (kind: string | null | undefined): kind is ChiefKind =>
  !!kind && (CHIEF_KINDS as readonly string[]).includes(kind)

const optionsOf = (value: unknown): ChiefOption[] =>
  Array.isArray(value)
    ? value.filter(
        (o): o is ChiefOption =>
          !!o && typeof o.label === 'string' && typeof o.message === 'string',
      )
    : []

const clipEnd = (text: string, max: number) =>
  text.length <= max ? text : `…${text.slice(text.length - max)}`
const clipStart = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max)}…`

/** Dashboards showing the thread read its decisions again. */
async function threadChanged(scope: Scope, sessionId: string) {
  const row = await scoped(scope).session.findFirst({
    where: { id: sessionId },
    select: { status: true },
  })
  if (row) void hubs.get(scope.workspaceId).broadcast(threadUpdated(sessionId, row.status))
}

// ---------------------------------------------------------------------------
// The question a turn ended on
// ---------------------------------------------------------------------------

type Ask = {
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
// A turn ended: Chief reads its question
// ---------------------------------------------------------------------------

/**
 * Called once a thread's events are kept, a turn having ended with it idle: when its person lets
 * Chief answer for them and the turn ended on a question, Chief's decision starts. Not in a
 * sub-thread (it reports to its parent's teammate), a routine's or a trigger's run, a playbook's,
 * a thread several people ask in (whose name would it answer in?), nor on Chief's own questions.
 */
export async function noteChiefAsks(
  session: { id: string; organizationId: string; workspaceId: string },
  ended: boolean,
) {
  if (!ended) return
  const scope: Scope = { organizationId: session.organizationId, workspaceId: session.workspaceId }
  const db = scoped(scope)
  const thread = await db.session.findFirst({
    where: {
      id: session.id,
      status: 'idle',
      origin: 'member',
      parentId: null,
      playbookRunId: null,
      scheduleId: null,
      archivedAt: null,
      doneAt: null,
      quiet: false,
      controlledByMemberId: null,
      startedBy: { chiefAnswers: true },
    },
    select: {
      id: true,
      teammateId: true,
      computerId: true,
      startedByMemberId: true,
      choicesDismissedSeq: true,
    },
  })
  if (!thread) return
  const asker = await askedBy(db, thread.id)
  if (asker && asker !== thread.startedByMemberId) return
  const ask = await openAsk(db, thread)
  if (!ask) return
  const [asking, chief] = await Promise.all([
    db.teammate.findFirst({ where: { id: ask.teammateId }, select: { kind: true } }),
    db.teammate.findFirst({ where: { kind: 'chief', archivedAt: null }, select: { id: true } }),
  ])
  if (!chief || !asking || asking.kind === 'chief') return
  // A runner that cannot run Chief's decision: the question waits for the person, as before.
  const protocol = await hubs.get(scope.workspaceId).runnerProtocol(thread.computerId)
  if (protocol !== undefined && protocol < CHIEF_PROTOCOL) return
  // Its answers in a row with no word from the person: this one is theirs.
  if ((await answersInARow(db, thread.id)) >= CHIEF_ANSWERS_IN_A_ROW) return
  let id: string
  try {
    const row = await db.chiefDecision.create({
      data: {
        sessionId: thread.id,
        memberId: thread.startedByMemberId,
        teammateId: ask.teammateId,
        askSeq: ask.seq,
        question: ask.cardQuestion,
        options: ask.options as unknown as Prisma.InputJsonValue,
        // Fixed now: started again after a restart, Chief's thread is the same one.
        childSessionId: `c${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      } as never,
      select: { id: true },
    })
    id = row.id
  } catch (error) {
    // Two ends of the same turn noted at once: one decision.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return
    throw error
  }
  await threadChanged(scope, thread.id)
  await startDecision(scope, id)
}

/** The person's first request in the thread, as they wrote it. */
async function firstRequest(db: ScopedDb, sessionId: string) {
  const rows = await db.sessionEvent.findMany({
    where: { sessionId, type: 'message.user' },
    orderBy: { seq: 'asc' },
    take: 20,
    select: { data: true },
  })
  const first = rows.find((r) => (r.data as { memberId?: string | null }).memberId)
  return (first?.data as { text?: string } | undefined)?.text ?? ''
}

/** The person's mandate, as the library has it now; null when they have none. */
export async function mandateText(scope: Scope) {
  const db = scoped(scope)
  const row = await db.document.findFirst({
    where: { kind: 'library', path: MANDATE_PATH, deletedAt: null },
  })
  if (!row) return null
  return documentText(scope, row).catch(() => null)
}

/** What Chief decided earlier in the thread, for the brief: the latest first. */
async function earlierDecisions(db: ScopedDb, sessionId: string, before: string) {
  const rows = await db.chiefDecision.findMany({
    where: { sessionId, id: { not: before }, verdict: { not: null } },
    orderBy: { createdAt: 'desc' },
    take: 5,
  })
  return rows.map((r) => {
    const option = r.optionIndex != null ? optionsOf(r.options)[r.optionIndex] : undefined
    const what =
      r.verdict === 'escalate' ? 'left it to the person' : `picked “${option?.label ?? '?'}”`
    const outcome =
      r.outcome === 'overruled'
        ? ', which the person marked as wrong'
        : r.outcome === 'disagreed'
          ? ', and the person answered otherwise'
          : r.outcome === 'agreed'
            ? ', and the person took it'
            : ''
    return `${what} (${r.kind ?? 'unsorted'})${outcome}`
  })
}

/**
 * Start Chief's decision thread, a sub-thread of the thread asking. Started again (after a
 * restart cut it off), it takes up the thread made then, and its prompt reaches it once. When it
 * cannot start (no account for Chief, the computer offline), the decision fails: the question is
 * the person's, as before.
 */
export async function startDecision(scope: Scope, decisionId: string) {
  const db = scoped(scope)
  const decision = await db.chiefDecision.findFirst({
    where: { id: decisionId, status: 'pending' },
    include: { member: { include: { user: { select: { name: true } } } } },
  })
  if (!decision) return
  const fail = async () => {
    await db.chiefDecision.updateMany({
      where: { id: decision.id, status: 'pending' },
      data: { status: 'failed' },
    })
    await threadChanged(scope, decision.sessionId)
  }
  let parent: LoadedThread
  try {
    parent = await loadThread(db, decision.sessionId)
  } catch {
    return fail()
  }
  if (await questionClosed(db, parent.id, decision.askSeq)) {
    await db.chiefDecision.updateMany({
      where: { id: decision.id, status: 'pending' },
      data: { status: 'superseded' },
    })
    return threadChanged(scope, parent.id)
  }
  const chief = await db.teammate.findFirst({ where: { kind: 'chief', archivedAt: null } })
  const asking = parent.teammates.find((t) => t.teammateId === decision.teammateId)?.teammate
  if (!chief || !asking) return fail()
  // Only what Chief may read of the library: a folder people closed to it stays closed here too.
  const readsMandate = (await teammateLibraryAccess(db, chief)).of(MANDATE_PATH) !== 'none'
  const [request, mandate, earlier] = await Promise.all([
    firstRequest(db, parent.id),
    readsMandate ? mandateText(scope) : null,
    earlierDecisions(db, parent.id, decision.id),
  ])
  const ask = await openAsk(db, parent)
  const options = optionsOf(decision.options)
  const text = chiefDecisionBrief({
    person: decision.member.user.name || 'the person',
    teammate: asking.name,
    threadTitle: parent.title,
    request: clipStart(request, REQUEST_CHARS),
    cardQuestion: decision.question,
    question: clipEnd(ask?.seq === decision.askSeq ? ask.question : '', QUESTION_CHARS),
    options,
    mandate: mandate && clipStart(mandate, MANDATE_CHARS),
    earlier,
  })
  try {
    // Imported here: work.ts reaches this file through the events it notes.
    const { startThread } = await import('./work.js')
    const { outcome } = await startThread(db, scope, {
      id: decision.childSessionId,
      teammate: chief,
      computer: parent.computer,
      memberId: parent.startedByMemberId,
      accountId: parent.accountId,
      title: `Chief's decision: ${parent.title}`,
      text,
      origin: { kind: 'child', parent, byTeammateId: decision.teammateId, awaited: false },
      projectId: parent.projectId,
      // A short read, not work: as quick as Chief's harness goes.
      effort: 'low',
      commandId: `chief:${decision.id}`,
      chiefDecisionId: decision.id,
    })
    if (outcome === 'offline') return fail()
  } catch (error) {
    console.warn(`chief decision ${decision.id}: did not start: ${String(error)}`)
    return fail()
  }
  await threadChanged(scope, parent.id)
}

/** Workspaces with a decision Chief has not made in DECISION_MINUTES (src/wakeups.ts). */
export async function dueDecisions(now = new Date()) {
  const rows = await prisma.chiefDecision.findMany({
    where: {
      status: 'pending',
      createdAt: { lt: new Date(now.getTime() - DECISION_MINUTES * 60_000) },
    },
    distinct: ['workspaceId'],
    select: { workspaceId: true },
  })
  return rows.map((r) => r.workspaceId)
}

/**
 * Decisions Chief has not made in DECISION_MINUTES (its thread stopped, or never started after a
 * restart): given up, each minute (src/wakeups.ts). The question is the person's.
 */
export async function settleStaleDecisions(workspaceId?: string) {
  const stale = await prisma.chiefDecision.findMany({
    where: {
      status: 'pending',
      createdAt: { lt: new Date(Date.now() - DECISION_MINUTES * 60_000) },
      ...(workspaceId ? { workspaceId } : {}),
    },
    select: { id: true, organizationId: true, workspaceId: true, sessionId: true },
    take: 100,
  })
  for (const d of stale) {
    const { count } = await prisma.chiefDecision.updateMany({
      where: { id: d.id, status: 'pending' },
      data: { status: 'failed' },
    })
    if (count)
      await threadChanged(
        { organizationId: d.organizationId, workspaceId: d.workspaceId },
        d.sessionId,
      )
  }
}

// ---------------------------------------------------------------------------
// Chief decides
// ---------------------------------------------------------------------------

/**
 * Chief's decision thread's events (src/children.ts sends them here rather than as a report): its
 * turn ended or failed. A decision it did not make by then fails. The thread is settled as a
 * child that reported nothing, delivered: its parent waits for it nowhere, and it is not at work.
 */
export async function noteDecisionEvents(
  scope: Scope,
  session: { id: string; parentId: string | null; chiefDecisionId: string },
  events: { event: { type: string; at: string; retrying?: boolean } }[],
) {
  const db = scoped(scope)
  const ended = events.some(
    ({ event }) =>
      event.type === 'turn.completed' || (event.type === 'error' && event.retrying !== true),
  )
  if (!ended) return
  await db.chiefDecision.updateMany({
    where: { id: session.chiefDecisionId, status: 'pending' },
    data: { status: 'failed' },
  })
  await db.session.updateMany({
    where: { id: session.id, reportDeliveredAt: null },
    data: {
      report: { status: 'nothing', summary: 'Decided.', at: new Date().toISOString() },
      reportDeliveredAt: new Date(),
    } as never,
  })
  if (session.parentId) await threadChanged(scope, session.parentId)
}

type DecideOp = Extract<ChiefOperation, { name: 'chief_decide' }>

/** chief_decide and chief_decisions, from Chief's threads. */
export async function handleChiefCall(
  db: ScopedDb,
  scope: Scope,
  session: { id: string; startedByMemberId: string; chiefDecisionId: string | null },
  teammate: { id: string; kind: string },
  op: ChiefOperation,
): Promise<object | { error: string }> {
  if (teammate.kind !== 'chief') return { error: 'Only Chief decides for the person.' }
  if (op.name === 'chief_decisions') return listDecisions(db, session.startedByMemberId, op.days)
  if (!session.chiefDecisionId)
    return {
      error: 'This thread decides no question: chief_decide is for Chief’s decision threads.',
    }
  return decide(scope, session.chiefDecisionId, op)
}

async function decide(scope: Scope, decisionId: string, op: DecideOp) {
  const db = scoped(scope)
  const decision = await db.chiefDecision.findFirst({ where: { id: decisionId } })
  if (!decision) return { error: 'That decision is gone.' }
  if (decision.status !== 'pending')
    return {
      recorded: false,
      next: 'Someone answered the question meanwhile, or it was given up: nothing more to do. End your turn.',
    }
  const options = optionsOf(decision.options)
  const index = op.option !== undefined ? op.option - 1 : null
  if (index !== null && index >= options.length)
    return { error: `There are ${options.length} answers: option is 1 to ${options.length}.` }
  if (op.verdict !== 'escalate' && index === null)
    return { error: 'Give option: the number of the answer you pick.' }
  if (op.verdict === 'park' && !op.parked)
    return { error: 'Give parked: the work you put off, in a line for the person’s list.' }
  const kind = ChiefQuestionKind.parse(op.kind)
  const { count } = await db.chiefDecision.updateMany({
    where: { id: decision.id, status: 'pending', verdict: null },
    data: {
      verdict: op.verdict,
      kind,
      optionIndex: index,
      reason: op.reason,
      basis: op.basis ?? null,
      parked: op.verdict === 'park' ? op.parked! : null,
      decidedAt: new Date(),
    },
  })
  if (!count) return { recorded: false, next: 'You decided this one already. End your turn.' }
  const status = await applyDecision(scope, decision.id)
  return {
    recorded: true,
    status,
    next:
      status === 'answered'
        ? 'Your answer went to the teammate in the person’s name. End your turn now, without a reply.'
        : status === 'superseded'
          ? 'The person answered meanwhile: nothing more to do. End your turn.'
          : 'It shows on the question for the person. End your turn now, without a reply.',
  }
}

/**
 * Where Chief's decision goes, under the thread's lock (the person's answer may come at the same
 * time): nowhere once the thread moved on; to the teammate on its own when the person lets Chief
 * answer that kind and it has not answered CHIEF_ANSWERS_IN_A_ROW times already; else it shows on
 * the question, as a suggestion or as left to the person.
 */
async function applyDecision(scope: Scope, decisionId: string) {
  const db = scoped(scope)
  const applied = await db.$transaction(async (tx) => {
    const row = await tx.chiefDecision.findFirst({
      where: { id: decisionId },
      include: { member: { select: { chiefAnswers: true, chiefAuto: true } } },
    })
    if (!row || row.status !== 'pending') return null
    await lockThread(tx, row.sessionId)
    const set = (status: 'superseded' | 'answered' | 'suggested' | 'escalated') =>
      tx.chiefDecision.updateMany({ where: { id: row.id, status: 'pending' }, data: { status } })
    if (await questionClosed(tx, row.sessionId, row.askSeq)) {
      await set('superseded')
      return { status: 'superseded' as const, row, wakeupId: null }
    }
    if (row.verdict === 'escalate') {
      await set('escalated')
      return { status: 'escalated' as const, row, wakeupId: null }
    }
    const option = row.optionIndex != null ? optionsOf(row.options)[row.optionIndex] : undefined
    const alone =
      !!option &&
      row.member.chiefAnswers &&
      isKind(row.kind) &&
      row.member.chiefAuto.includes(row.kind) &&
      (await answersInARow(tx, row.sessionId)) < CHIEF_ANSWERS_IN_A_ROW
    if (!alone) {
      await set('suggested')
      return { status: 'suggested' as const, row, wakeupId: null }
    }
    await set('answered')
    // Its work goes on Chief's word from the question on, until the person writes after it.
    await raiseChiefsWord(tx, row.sessionId, row.askSeq)
    // As a report's wake-up: stored with the decision, tried until it reaches the thread.
    const wakeup = await tx.wakeup.create({
      data: {
        sessionId: row.sessionId,
        teammateId: row.teammateId,
        kind: 'report',
        note: chiefAnswerMessage({
          decisionId: row.id,
          answer: option.message,
          reason: row.reason ?? '',
          basis: row.basis,
        }),
        wakeAt: new Date(),
        sourceId: `${CHIEF_SOURCE}${row.id}`,
      } as never,
    })
    return { status: 'answered' as const, row, wakeupId: wakeup.id }
  })
  if (!applied) {
    const now = await db.chiefDecision.findFirst({
      where: { id: decisionId },
      select: { status: true },
    })
    return now?.status ?? 'failed'
  }
  const { row } = applied
  await audit({
    ...scope,
    actor: { type: 'teammate', id: (await chiefId(db)) ?? 'chief' },
    action: `chief.${applied.status}`,
    target: { type: 'thread', id: row.sessionId },
    data: { decisionId: row.id, kind: row.kind, verdict: row.verdict, option: row.optionIndex },
  })
  if (applied.status === 'answered' && row.verdict === 'park' && row.parked)
    await parkLine(scope, row.sessionId, row.parked)
  if (applied.wakeupId) {
    const { fireNow } = await import('./wakeups.js')
    await fireNow(applied.wakeupId)
  }
  await threadChanged(scope, row.sessionId)
  return applied.status
}

const chiefId = async (db: ScopedDb) =>
  (await db.teammate.findFirst({ where: { kind: 'chief' }, select: { id: true } }))?.id

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

/** Work Chief put off in the person's name: a line of their list of it, made when missing. */
async function parkLine(scope: Scope, sessionId: string, text: string) {
  const db = scoped(scope)
  const [thread, chief] = await Promise.all([
    db.session.findFirst({ where: { id: sessionId }, select: { title: true } }),
    db.teammate.findFirst({ where: { kind: 'chief' } }),
  ])
  // Only where Chief may save: a folder people closed to it stays closed, and the decision keeps
  // what was put off (chief_decisions lists it).
  if (!chief || (await teammateLibraryAccess(db, chief)).of(PARKED_PATH) !== 'read_write') return
  const id = chief.id
  try {
    const { addListLine } = await import('./lists.js')
    await addListLine(
      db,
      scope,
      { type: 'teammate', id: id ?? 'chief' },
      {
        path: PARKED_PATH,
        header:
          '# Parked by Chief\n\nWork Chief put off in your name, to look at again. Hand a line to a ' +
          'teammate when its time comes, or delete it.\n',
        text: `${text}${thread ? ` (from “${thread.title}”)` : ''}`,
      },
    )
  } catch (error) {
    // The decision stands without its line: Chief's look back lists what it parked.
    console.warn(`chief: could not add a parked line: ${String(error)}`)
  }
}

// ---------------------------------------------------------------------------
// The person answers
// ---------------------------------------------------------------------------

/**
 * A thread's events are kept (src/hub/runner-messages.ts): in their order, an answer of Chief's
 * reaching the teammate puts the thread on Chief's word from there, and a person's message after
 * it lifts that. The questions before a person's message are answered: Chief's decisions on them
 * still to come are moot, one not on its way never goes, and a suggestion counts toward trust,
 * their pick agreeing with Chief's or not, which may earn a ticket offering to let Chief answer
 * that kind on its own. Hooks that run late change nothing a later event decided.
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
        { chiefDecisions: { some: { status: { in: ['pending', 'suggested', 'answered'] } } } },
      ],
    },
  })
  if (!involved) return
  const measured = await db.$transaction(async (tx) => {
    await lockThread(tx, session.id)
    for (const e of marks)
      if (e.event.memberId) await lowerChiefsWord(tx, session.id, e.seq)
      else await raiseChiefsWord(tx, session.id, e.seq)
    if (!message) return []
    // Their word came before an answer of Chief's went: that answer never goes. (Kept for the
    // computer, their word did that already: src/chief-order.ts.)
    await withdrawAnswers(tx, session.id, message.seq)
    const open = await tx.chiefDecision.findMany({
      where: {
        sessionId: session.id,
        askSeq: { lt: message.seq },
        status: { in: ['pending', 'suggested'] },
        outcome: null,
      },
    })
    const counted: typeof open = []
    for (const d of open) {
      if (d.status === 'pending') {
        await tx.chiefDecision.updateMany({
          where: { id: d.id, status: 'pending' },
          data: { status: 'superseded' },
        })
        continue
      }
      const option = d.optionIndex != null ? optionsOf(d.options)[d.optionIndex] : undefined
      // Only the person Chief answers for measures it.
      if (!option || message.event.memberId !== d.memberId) continue
      const text = message.event.text ?? ''
      const agreed =
        text === option.message || !!pickedChoice([option], text) || text.trim() === option.label
      const { count } = await tx.chiefDecision.updateMany({
        where: { id: d.id, outcome: null },
        data: { outcome: agreed ? 'agreed' : 'disagreed', outcomeAt: new Date() },
      })
      if (count) counted.push({ ...d, outcome: agreed ? 'agreed' : 'disagreed' })
    }
    return counted
  })
  for (const d of measured) {
    if (d.outcome === 'agreed' && d.verdict === 'park' && d.parked)
      await parkLine(scope, d.sessionId, d.parked)
    if (isKind(d.kind)) await offerAlone(db, scope, d.memberId, d.kind, d.sessionId)
  }
  await threadChanged(scope, session.id)
}

/**
 * Since when a kind's suggestions count toward trust: after the person last refused to let Chief
 * answer it alone, marked one of its answers wrong, or changed what it answers alone themselves.
 */
async function trustSince(db: ScopedDb, memberId: string, kind: ChiefKind) {
  const [member, refused, overruled] = await Promise.all([
    db.member.findFirst({ where: { id: memberId }, select: { chiefAutoChangedAt: true } }),
    db.ticket.findFirst({
      where: {
        type: 'approval',
        status: 'denied',
        AND: [
          { payload: { path: ['chiefPromotion', 'memberId'], equals: memberId } },
          { payload: { path: ['chiefPromotion', 'kind'], equals: kind } },
        ],
      },
      orderBy: { resolvedAt: 'desc' },
      select: { resolvedAt: true },
    }),
    db.chiefDecision.findFirst({
      where: { memberId, kind, outcome: 'overruled' },
      orderBy: { outcomeAt: 'desc' },
      select: { outcomeAt: true },
    }),
  ])
  const times = [member?.chiefAutoChangedAt, refused?.resolvedAt, overruled?.outcomeAt].filter(
    (t): t is Date => !!t,
  )
  return times.length ? new Date(Math.max(...times.map((t) => t.getTime()))) : null
}

/** What a member's latest answers to Chief's suggestions of a kind say: offer to let it answer alone? */
export async function trustOf(db: ScopedDb, memberId: string, kind: ChiefKind) {
  const since = await trustSince(db, memberId, kind)
  const window = await db.chiefDecision.findMany({
    where: {
      memberId,
      kind,
      status: 'suggested',
      outcome: { in: ['agreed', 'disagreed'] },
      ...(since ? { outcomeAt: { gt: since } } : {}),
    },
    orderBy: { outcomeAt: 'desc' },
    take: CHIEF_PROMOTION.decisions,
    select: { outcome: true },
  })
  return { decided: window.length, agreed: window.filter((d) => d.outcome === 'agreed').length }
}

/**
 * One ticket, in the thread of the answer that earned it, offering the person to let Chief answer
 * a kind of question on its own: once CHIEF_PROMOTION.agreed of their latest
 * CHIEF_PROMOTION.decisions answers to its suggestions of that kind were Chief's pick. None while
 * one is open, nor for a kind it answers alone already.
 */
async function offerAlone(
  db: ScopedDb,
  scope: Scope,
  memberId: string,
  kind: ChiefKind,
  sessionId: string,
) {
  const member = await db.member.findFirst({
    where: { id: memberId },
    select: { chiefAnswers: true, chiefAuto: true },
  })
  if (!member?.chiefAnswers || member.chiefAuto.includes(kind)) return
  const open = await db.ticket.count({
    where: {
      type: 'approval',
      status: 'open',
      AND: [
        { payload: { path: ['chiefPromotion', 'memberId'], equals: memberId } },
        { payload: { path: ['chiefPromotion', 'kind'], equals: kind } },
      ],
    },
  })
  if (open) return
  const trust = await trustOf(db, memberId, kind)
  if (trust.decided < CHIEF_PROMOTION.decisions || trust.agreed < CHIEF_PROMOTION.agreed) return
  const ticket = await db.ticket.create({
    data: {
      sessionId,
      type: 'approval',
      title: `Let Chief answer ${CHIEF_KIND_LABELS[kind].label.toLowerCase()} for you on its own?`,
      payload: { chiefPromotion: { memberId, kind, agreed: trust.agreed, decided: trust.decided } },
    } as never,
  })
  await audit({
    ...scope,
    actor: { type: 'system', id: 'brigade' },
    action: 'chief.promotion_proposed',
    target: { type: 'member', id: memberId },
    data: { kind, agreed: trust.agreed, decided: trust.decided, ticketId: ticket.id },
  })
}

/** The person decided the ticket offering to let Chief answer a kind alone (src/decide.ts). */
export async function decideChiefPromotion(
  scope: Scope & { memberId: string },
  ticket: { id: string; sessionId: string | null; payload: unknown },
  approved: boolean,
) {
  const db = scoped(scope)
  const promotion = (ticket.payload as { chiefPromotion?: { memberId: string; kind: string } })
    .chiefPromotion
  if (!promotion || !isKind(promotion.kind))
    throw new HTTPException(400, { message: 'Not an offer' })
  // In their name: theirs alone to allow.
  if (promotion.memberId !== scope.memberId)
    throw new HTTPException(403, { message: 'Only the person Chief answers for can decide this' })
  const { count } = await db.ticket.updateMany({
    where: { id: ticket.id, status: 'open' },
    data: {
      status: approved ? 'approved' : 'denied',
      resolvedByMemberId: scope.memberId,
      resolvedAt: new Date(),
    },
  })
  if (!count) throw new HTTPException(404, { message: 'Ticket not found or already resolved' })
  if (approved) {
    const member = await db.member.findFirst({
      where: { id: scope.memberId },
      select: { chiefAuto: true },
    })
    if (member && !member.chiefAuto.includes(promotion.kind))
      await db.member.update({
        where: { id: scope.memberId },
        data: { chiefAuto: [...member.chiefAuto, promotion.kind] },
      })
  }
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: approved ? 'chief.alone_allowed' : 'chief.alone_refused',
    target: { type: 'member', id: scope.memberId },
    data: { kind: promotion.kind, ticketId: ticket.id },
  })
  if (ticket.sessionId) await threadChanged(scope, ticket.sessionId)
}

/**
 * The person marks one of Chief's answers as wrong: the teammate is told to stop what it started
 * on it, and Chief goes back to suggesting that kind of question to them.
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
  const member = await db.member.findFirst({
    where: { id: decision.memberId },
    select: { chiefAuto: true },
  })
  if (member && decision.kind && member.chiefAuto.includes(decision.kind))
    await db.member.update({
      where: { id: decision.memberId },
      data: { chiefAuto: member.chiefAuto.filter((k) => k !== decision.kind) },
    })
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: 'chief.overruled',
    target: { type: 'thread', id: sessionId },
    data: { decisionId: decision.id, kind: decision.kind },
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
// What threads and the person see
// ---------------------------------------------------------------------------

/** A thread's decisions, as its view shows them on its questions. */
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
    verdict: (r.verdict as ChiefDecisionView['verdict']) ?? null,
    kind: ChiefQuestionKind.safeParse(r.kind).data ?? null,
    option: r.optionIndex != null ? (optionsOf(r.options)[r.optionIndex] ?? null) : null,
    reason: r.reason,
    basis: r.basis,
    outcome: r.outcome,
    childSessionId: r.childSessionId,
    createdAt: r.createdAt.toISOString(),
  }))
}

/** Chief's recent decisions for a member (chief_decisions, and their settings): what it did, and how they took it. */
async function listDecisions(db: ScopedDb, memberId: string, days = 7) {
  const since = new Date(Date.now() - days * 24 * 60 * 60_000)
  const rows = await db.chiefDecision.findMany({
    where: { memberId, createdAt: { gte: since }, verdict: { not: null } },
    include: { session: { select: { id: true, title: true } } },
    orderBy: { createdAt: 'desc' },
    take: 200,
  })
  return {
    days,
    decisions: rows.map((r) => ({
      at: r.createdAt.toISOString(),
      thread: { id: r.session.id, title: r.session.title },
      kind: r.kind,
      verdict: r.verdict,
      answer: r.optionIndex != null ? (optionsOf(r.options)[r.optionIndex]?.label ?? null) : null,
      status: r.status,
      outcome: r.outcome,
      parked: r.parked,
    })),
    totals: await chiefStats(db, memberId, days),
  }
}

/** A member's numbers over `days`: what Chief read, answered alone, suggested and how often they agreed. */
export async function chiefStats(db: ScopedDb, memberId: string, days = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60_000)
  const rows = await db.chiefDecision.groupBy({
    by: ['status', 'outcome'],
    where: { memberId, createdAt: { gte: since } },
    _count: { _all: true },
  })
  const count = (status?: string, outcome?: string | null) =>
    rows
      .filter(
        (r) => (!status || r.status === status) && (outcome === undefined || r.outcome === outcome),
      )
      .reduce((n, r) => n + r._count._all, 0)
  return {
    days,
    questions: count(),
    answered: count('answered'),
    overruled: count('answered', 'overruled'),
    suggested: count('suggested'),
    agreed: count('suggested', 'agreed'),
    disagreed: count('suggested', 'disagreed'),
    escalated: count('escalated'),
  }
}

/** A member's settings, with how each kind stands (src/routes/workspaces.ts). */
export async function chiefSettings(db: ScopedDb, memberId: string) {
  const member = await db.member.findFirst({
    where: { id: memberId },
    select: { chiefAnswers: true, chiefAuto: true },
  })
  const kinds = await Promise.all(
    CHIEF_KINDS.map(async (kind) => ({
      kind,
      alone: !!member?.chiefAuto.includes(kind),
      ...(await trustOf(db, memberId, kind)),
    })),
  )
  const mandate = await db.document.findFirst({
    where: { kind: 'library', path: MANDATE_PATH, deletedAt: null },
    select: { id: true },
  })
  return {
    on: member?.chiefAnswers ?? false,
    kinds,
    mandate: mandate ? { id: mandate.id, path: MANDATE_PATH } : null,
    stats: await chiefStats(db, memberId),
  }
}
