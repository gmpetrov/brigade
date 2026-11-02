// Choices nobody picked yet wait on a person: one rule for everything that counts what waits on
// someone (Home's Needs you and its count, the sidebar, the app badge, a list item's state, the
// Board, the Tasks board), as failed threads do (src/failed.ts).
//
// A teammate that ends its reply on a choices card (OFFER_CHOICES_TOOL, written as a `choices`
// block) offered alternatives for a person to pick from: the thread stops there until someone
// does. It waits while the thread is idle, until a message comes in it: a person's (a pick is
// one) or one Brigade writes there (a wake-up, a child's report), as the card in the thread
// reads it: any message after the card closes it. And only while recent: a choice nobody made in CHOICE_DAYS
// closes as a stopped thread does (docs/board.md). Not in a child thread (it reports to its
// parent's teammate), a routine's run, a playbook's run nobody joined, nor once the thread is
// archived or done. It waits on whoever started the thread, unless they put it away for later;
// the boards, which every member shares, take it whoever started it.
import { type Choices, OFFER_CHOICES_TOOL, safeChoices, STOPPED_DAYS } from '@brigade/contracts'
import type { Prisma, ScopedDb } from './db.js'

const DAY = 24 * 60 * 60_000
/** A choice nobody made waits this long, then closes with its thread, as Stopped does. */
export const CHOICE_DAYS = STOPPED_DAYS
/** The most threads read for a member at once, the latest first. */
const LISTED = 100

/** A thread whose choices may wait on a person, whoever started it. */
export const CHOICE_THREAD = {
  status: 'idle',
  parentId: null,
  scheduleId: null,
  archivedAt: null,
  doneAt: null,
  OR: [{ playbookRunId: null, quiet: false }, { surfacedAt: { not: null } }],
} satisfies Prisma.SessionWhereInput

/** Choices a teammate offered that nobody picked: since when, and what it asked. */
export type ChoiceWaiting = { at: Date; question: string; choices: Choices }

/**
 * The choices card each of these threads ended on that nobody answered, if recent: the latest
 * one after the last message a person wrote in it.
 */
async function choicesOf(db: ScopedDb, sessionIds: string[], now: Date) {
  const found = new Map<string, ChoiceWaiting>()
  if (!sessionIds.length) return found
  const written = await db.sessionEvent.groupBy({
    by: ['sessionId'],
    where: { sessionId: { in: sessionIds }, type: 'message.user' },
    _max: { seq: true },
  })
  const after = new Map(written.map((w) => [w.sessionId, w._max.seq ?? -1]))
  // Only what came after each one's last message: one turn or a few, never the whole thread.
  const offers = await db.sessionEvent.findMany({
    where: {
      OR: sessionIds.map((id) => ({ sessionId: id, seq: { gt: after.get(id) ?? -1 } })),
      type: 'tool.started',
      at: { gte: new Date(now.getTime() - CHOICE_DAYS * DAY) },
      data: { path: ['toolName'], string_ends_with: OFFER_CHOICES_TOOL },
    },
    orderBy: { seq: 'desc' },
    select: { sessionId: true, at: true, data: true },
  })
  for (const offer of offers) {
    if (found.has(offer.sessionId)) continue
    // As the thread's card reads it: one it could not show does not wait on anyone.
    const choices = safeChoices((offer.data as { input?: unknown } | null)?.input)
    if (choices) found.set(offer.sessionId, { at: offer.at, question: choices.question, choices })
  }
  return found
}

/**
 * Among these threads, those whose choices wait on a person, whoever started them (the boards'
 * rule: Tasks, a list's items, the Board): by thread.
 */
export async function choicesWaitingAmong(
  db: ScopedDb,
  sessionIds: string[],
  now = new Date(),
): Promise<Map<string, ChoiceWaiting>> {
  if (!sessionIds.length) return new Map()
  const threads = await db.session.findMany({
    where: { id: { in: sessionIds }, ...CHOICE_THREAD },
    select: { id: true },
  })
  return choicesOf(
    db,
    threads.map((t) => t.id),
    now,
  )
}

export type ThreadChoice = ChoiceWaiting & {
  id: string
  title: string
  teammate: { id: string; name: string }
}

/**
 * The threads whose choices wait on this member: those they started, not put away for later,
 * active in the last CHOICE_DAYS; the latest first.
 */
export async function choicesWaitingOn(
  db: ScopedDb,
  memberId: string,
  now = new Date(),
): Promise<ThreadChoice[]> {
  const threads = await db.session.findMany({
    where: {
      ...CHOICE_THREAD,
      startedByMemberId: memberId,
      laters: { none: { memberId } },
      updatedAt: { gte: new Date(now.getTime() - CHOICE_DAYS * DAY) },
    },
    orderBy: { updatedAt: 'desc' },
    take: LISTED,
    select: { id: true, title: true, teammate: { select: { id: true, name: true } } },
  })
  const choices = await choicesOf(
    db,
    threads.map((t) => t.id),
    now,
  )
  return threads
    .flatMap((t): ThreadChoice[] => {
      const c = choices.get(t.id)
      return c ? [{ id: t.id, title: t.title, teammate: t.teammate, ...c }] : []
    })
    .sort((a, b) => b.at.getTime() - a.at.getTime())
}
