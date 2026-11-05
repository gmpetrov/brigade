// Chief's daily pass for a person (docs/chief-answers.md). Once a day, from CHIEF_PASS_HOUR in
// their timezone, when something waits on them in a workspace, Brigade starts a thread of Chief's
// on their account: quiet, it shows in no list. Its brief (chiefPassBrief) numbers what waits on
// them: the questions their teammates ended on, the threads that failed, their tickets and pull
// requests; with their rules and their recent answers. Chief answers in their name the questions
// their rules settle (chief_answer, src/chief-answers.ts), tries failed threads again
// (chief_retry), then reports once (chief_report): what is left to them, with what it would do,
// what it noticed across their threads, and rules worth adding. Today shows it (passView). It acts
// only on what its brief lists, by number. Off (Member.chiefPass, the default), nothing runs.
import { randomUUID } from 'node:crypto'
import {
  CHIEF_PASS_HOUR,
  CHIEF_PASS_PROTOCOL,
  type ChiefOperation,
  type ChiefOption,
  ChiefPassItem,
  ChiefPassReport,
  type ChiefPassView,
  type ChiefRecentAnswer,
  chiefPassBrief,
  choiceMessage,
  OFFER_CHOICES_TOOL,
  pickedChoice,
  safeChoices,
  safeReplies,
  SUGGEST_REPLIES_TOOL,
  bareToolName,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { answerInTheirName, openAsk, optionsOf, UNSETTLED } from './chief-answers.js'
import { questionClosed } from './chief-order.js'
import { personRules, ruleState, setRulesByChief } from './chief-rules.js'
import { prisma, Prisma, scoped, type Scope, type ScopedDb } from './db.js'
import { failedThreadsOf } from './failed.js'
import { hubs, threadUpdated } from './hub.js'
import { latersOf } from './later.js'
import { needsAttention } from './pull-requests.js'
import { askedBy, loadThread, SEVERAL_ASKERS } from './thread-spec.js'

const DAY = 24 * 60 * 60_000
/** Threads whose open question a pass reads: those active in the last days. */
const OPEN_DAYS = 7
/** The person's answers Chief learns rules from: the last days'. */
const ANSWERS_DAYS = 14
/** At most this many threads read for an open question, and items listed. */
const THREADS_READ = 40
const ITEMS_MAX = 30
/** A pass's view shows on Today this long after it started. */
const SHOWN_FOR = 36 * 60 * 60_000
/** A pass not done in this long is over: what it did stays, the rest waits on the person. */
const PASS_MINUTES = 30

/** A date's day (YYYY-MM-DD) and hour in a timezone. */
export function localDay(timezone: string, at: Date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  )
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) }
}

/** A member's timezone for their pass: theirs, else UTC. */
const zoneOf = (member: { timezone: string | null }) => {
  if (!member.timezone) return 'UTC'
  try {
    localDay(member.timezone, new Date())
    return member.timezone
  } catch {
    return 'UTC'
  }
}

// ---------------------------------------------------------------------------
// When a pass is due
// ---------------------------------------------------------------------------

/**
 * Each member with their pass on, in each workspace of their organization, whose day in their
 * timezone reached CHIEF_PASS_HOUR and who has had no pass there that day.
 */
async function duePairs(now: Date, workspaceId?: string) {
  const members = await prisma.member.findMany({
    where: { chiefPass: true },
    select: { id: true, organizationId: true, timezone: true },
  })
  const pairs: { memberId: string; organizationId: string; workspaceId: string; day: string }[] = []
  for (const member of members) {
    const { day, hour } = localDay(zoneOf(member), now)
    if (hour < CHIEF_PASS_HOUR) continue
    const workspaces = await prisma.workspace.findMany({
      where: {
        organizationId: member.organizationId,
        deletingAt: null,
        ...(workspaceId ? { id: workspaceId } : {}),
      },
      select: { id: true },
    })
    if (!workspaces.length) continue
    const had = await prisma.chiefPass.findMany({
      where: { memberId: member.id, day, workspaceId: { in: workspaces.map((w) => w.id) } },
      select: { workspaceId: true },
    })
    const done = new Set(had.map((p) => p.workspaceId))
    for (const w of workspaces)
      if (!done.has(w.id))
        pairs.push({
          memberId: member.id,
          organizationId: member.organizationId,
          workspaceId: w.id,
          day,
        })
  }
  return pairs
}

/** Workspaces with a member's pass due, or one that ran too long (src/jobs.ts). */
export async function duePasses(now = new Date()) {
  const stale = await prisma.chiefPass.findMany({
    where: {
      status: 'running',
      createdAt: { lt: new Date(now.getTime() - PASS_MINUTES * 60_000) },
    },
    distinct: ['workspaceId'],
    select: { workspaceId: true },
  })
  return [
    ...new Set([
      ...(await duePairs(now)).map((p) => p.workspaceId),
      ...stale.map((p) => p.workspaceId),
    ]),
  ]
}

/** Start the passes due, of one workspace or all, each minute (src/jobs.ts). */
export async function runDuePasses(workspaceId?: string, now = new Date()) {
  for (const pair of await duePairs(now, workspaceId))
    await startPass(
      { organizationId: pair.organizationId, workspaceId: pair.workspaceId },
      pair.memberId,
      pair.day,
      now,
    ).catch((error: unknown) =>
      console.error(`chief pass of ${pair.memberId} in ${pair.workspaceId}: ${String(error)}`),
    )
  await settleStalePasses(workspaceId, now)
}

/** Passes whose thread stopped without reporting, or never started after a restart: failed. */
async function settleStalePasses(workspaceId: string | undefined, now: Date) {
  const stale = await prisma.chiefPass.findMany({
    where: {
      status: 'running',
      createdAt: { lt: new Date(now.getTime() - PASS_MINUTES * 60_000) },
      ...(workspaceId ? { workspaceId } : {}),
    },
    select: { id: true, organizationId: true, workspaceId: true, sessionId: true },
    take: 100,
  })
  for (const pass of stale) {
    const { count } = await prisma.chiefPass.updateMany({
      where: { id: pass.id, status: 'running' },
      data: { status: 'failed', finishedAt: now },
    })
    if (count) await archivePassThread(pass, pass.sessionId)
  }
}

/** A pass's thread, once the pass is over: archived, as nobody comes back to it but from Today. */
async function archivePassThread(scope: Scope, sessionId: string | null) {
  if (!sessionId) return
  const { setThreadArchived } = await import('./thread-archive.js')
  await setThreadArchived(scope, sessionId, true).catch((error: unknown) =>
    console.warn(`chief pass thread ${sessionId}: not archived: ${String(error)}`),
  )
}

// ---------------------------------------------------------------------------
// What waits on the person
// ---------------------------------------------------------------------------

type Item = ChiefPassItem
type Draft = Item extends infer I ? (I extends Item ? Omit<I, 'n'> : never) : never

/**
 * What waits on a member in this workspace, numbered: the questions their teammates ended on in
 * their own threads (that Chief may answer), their failed threads (that it may try again), then
 * their tickets and pull requests (always theirs). Not what they put away for later.
 */
export async function passItems(db: ScopedDb, memberId: string, now = new Date()) {
  const later = await latersOf(db, memberId)
  const drafts: Draft[] = []
  const threads = await db.session.findMany({
    where: {
      startedByMemberId: memberId,
      status: 'idle',
      origin: 'member',
      parentId: null,
      playbookRunId: null,
      scheduleId: null,
      archivedAt: null,
      doneAt: null,
      quiet: false,
      controlledByMemberId: null,
      chiefPassId: null,
      chiefDecisionId: null,
      updatedAt: { gte: new Date(now.getTime() - OPEN_DAYS * DAY) },
      OR: [{ askedByMemberId: memberId }, { askedByMemberId: null }],
    },
    orderBy: { updatedAt: 'desc' },
    take: THREADS_READ,
    select: { id: true, title: true, teammateId: true, choicesDismissedSeq: true },
  })
  for (const thread of threads) {
    if (later.has(thread.id)) continue
    const ask = await openAsk(db, thread)
    if (!ask) continue
    const [teammate, answered] = await Promise.all([
      db.teammate.findFirst({ where: { id: ask.teammateId }, select: { name: true, kind: true } }),
      db.chiefDecision.count({
        where: { sessionId: thread.id, askSeq: ask.seq, status: { notIn: UNSETTLED } },
      }),
    ])
    // Chief's own questions are the person's; one answered once is not answered again.
    if (!teammate || teammate.kind === 'chief' || answered) continue
    drafts.push({
      kind: 'question',
      title: thread.title,
      sessionId: thread.id,
      teammate: teammate.name,
      teammateId: ask.teammateId,
      askSeq: ask.seq,
      options: ask.options,
      question: ask.question.slice(-4_000),
      cardQuestion: ask.cardQuestion,
    })
  }
  const failed = await failedThreadsOf(db, memberId, now)
  for (const t of failed.threads)
    drafts.push({
      kind: 'failed',
      title: t.title,
      sessionId: t.id,
      teammate: t.teammate.name,
      error: t.error ?? 'its turn stopped on an error',
    })
  const tickets = await db.ticket.findMany({
    where: {
      status: 'open',
      OR: [
        { session: { startedByMemberId: memberId, archivedAt: null, quiet: false } },
        { sessionId: null, payload: { path: ['memberId'], equals: memberId } },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { type: true, title: true, session: { select: { id: true, title: true } } },
  })
  for (const t of tickets)
    if (!t.session || !later.has(t.session.id))
      drafts.push({
        kind: 'ticket',
        title: t.session?.title ?? 'A ticket',
        sessionId: t.session?.id ?? null,
        ticket: t.title,
        type: t.type,
      })
  const pulls = await needsAttention(db, [...later.keys()], { startedBy: memberId })
  for (const p of pulls)
    drafts.push({
      kind: 'pull',
      title: p.session?.title ?? p.title,
      sessionId: p.session?.id ?? null,
      pull: `${p.repository}#${p.number}: ${p.title}`,
      state: p.mergeStatus === 'stuck' ? 'its merge stopped' : 'ready to merge',
    })
  return drafts.slice(0, ITEMS_MAX).map((d, i) => ChiefPassItem.parse({ ...d, n: i + 1 }))
}

/** Whether a person's message answered the card: its option's words, a choice, or its label. */
function picked(options: ChiefOption[], text: string) {
  return (
    options.find((o) => text === o.message || text.trim() === o.label) ??
    pickedChoice(options, text) ??
    null
  )
}

/**
 * The person's answers to their teammates' questions lately: what Chief learns rules from. A
 * question answered by their own words shows those, cut short.
 */
export async function recentAnswers(
  db: ScopedDb,
  scope: Scope,
  memberId: string,
  now = new Date(),
): Promise<ChiefRecentAnswer[]> {
  const since = new Date(now.getTime() - ANSWERS_DAYS * DAY)
  const rows = await db.$queryRaw<
    { title: string; card: unknown; reply: unknown; said: unknown }[]
  >`
    SELECT s.title, c.data AS card, r.data AS reply, q.data AS said
    FROM "Session" s
    JOIN "SessionEvent" c ON c."sessionId" = s.id AND c.type = 'tool.started'
    JOIN LATERAL (
      SELECT data FROM "SessionEvent" r
      WHERE r."sessionId" = c."sessionId" AND r.type = 'message.user' AND r.seq > c.seq
      ORDER BY r.seq ASC LIMIT 1
    ) r ON true
    LEFT JOIN LATERAL (
      SELECT data FROM "SessionEvent" q
      WHERE q."sessionId" = c."sessionId" AND q.type = 'message.done' AND q.seq < c.seq
      ORDER BY q.seq DESC LIMIT 1
    ) q ON true
    WHERE s."workspaceId" = ${scope.workspaceId} AND s."startedByMemberId" = ${memberId}
      AND s."updatedAt" >= ${since} AND s."chiefPassId" IS NULL AND c.at >= ${since}
      AND (c.data->>'toolName' LIKE ${`%${SUGGEST_REPLIES_TOOL}`}
        OR c.data->>'toolName' LIKE ${`%${OFFER_CHOICES_TOOL}`})
    ORDER BY c.at DESC
    LIMIT 60`
  const answers: ChiefRecentAnswer[] = []
  for (const row of rows) {
    const reply = row.reply as { memberId?: string | null; text?: string } | null
    if (reply?.memberId !== memberId || !reply.text?.trim()) continue
    const card = row.card as { toolName?: string; input?: unknown } | null
    const tool = bareToolName(card?.toolName ?? '')
    const choices = tool === OFFER_CHOICES_TOOL ? safeChoices(card?.input) : null
    const options: ChiefOption[] = choices
      ? choices.options.map((o) => ({ label: o.label, message: choiceMessage(o) }))
      : (safeReplies(card?.input)?.replies ?? []).map((r) => ({ label: r, message: r }))
    if (!options.length) continue
    const said = ((row.said as { text?: string } | null)?.text ?? '').trim()
    const question = choices?.question?.trim() || said.slice(-300)
    const pick = picked(options, reply.text)
    answers.push({
      thread: row.title,
      question: `${question} [${options.map((o) => o.label).join(' / ')}]`,
      picked: pick ? pick.label : `wrote: "${reply.text.trim().slice(0, 160)}"`,
    })
    if (answers.length >= 25) break
  }
  return answers
}

// ---------------------------------------------------------------------------
// A pass
// ---------------------------------------------------------------------------

/**
 * A member's pass in a workspace, for their day: claimed once (ChiefPass, one a day), then its
 * thread started with its brief when something waits on them; idle when nothing does.
 */
export async function startPass(scope: Scope, memberId: string, day: string, now = new Date()) {
  const db = scoped(scope)
  const [chief, on] = await Promise.all([
    db.teammate.findFirst({ where: { kind: 'chief', archivedAt: null } }),
    // Turned off since it was found due: none today.
    db.member.count({ where: { id: memberId, chiefPass: true } }),
  ])
  if (!chief || !on) return null
  let pass: { id: string; sessionId: string | null }
  try {
    pass = await db.chiefPass.create({
      data: {
        memberId,
        day,
        // By the clock the pass was due by: its time to settle counts from it.
        createdAt: now,
        // Fixed now: started again after a restart, its thread is the same one.
        sessionId: `c${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      } as never,
      select: { id: true, sessionId: true },
    })
  } catch (error) {
    // Claimed already, by another tick: one pass a day.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return null
    throw error
  }
  const end = (status: 'failed' | 'idle') =>
    db.chiefPass.updateMany({
      where: { id: pass.id, status: 'running' },
      data: { status, finishedAt: new Date() },
    })
  const items = await passItems(db, memberId, now)
  if (!items.length) {
    await end('idle')
    return pass.id
  }
  await db.chiefPass.updateMany({
    where: { id: pass.id },
    data: { items: items as unknown as Prisma.InputJsonValue },
  })
  // The workspace's cloud computer, or else the member's own machine, as a routine's.
  const computer =
    (await db.computer.findFirst({ where: { kind: 'cloud', status: { not: 'destroyed' } } })) ??
    (await db.computer.findFirst({
      where: { kind: 'member_machine', memberId },
      orderBy: { updatedAt: 'desc' },
    }))
  if (!computer) {
    await end('failed')
    return pass.id
  }
  // A runner that cannot run it: what waits on them waits, as before.
  const protocol = await hubs.get(scope.workspaceId).runnerProtocol(computer.id)
  if (protocol !== undefined && protocol < CHIEF_PASS_PROTOCOL) {
    await end('failed')
    return pass.id
  }
  const [rules, member, answers] = await Promise.all([
    personRules(db, memberId),
    db.member.findFirst({ where: { id: memberId }, select: { chiefRulesRefused: true } }),
    recentAnswers(db, scope, memberId, now),
  ])
  try {
    // Imported here: work.ts reaches this file through the events it notes.
    const { startThread } = await import('./work.js')
    const { outcome } = await startThread(db, scope, {
      id: pass.sessionId!,
      teammate: chief,
      computer,
      memberId,
      askedByMemberId: memberId,
      title: `Chief's pass · ${day}`,
      text: chiefPassBrief({
        person: rules?.person ?? 'the person',
        day,
        rules: rules?.text ?? null,
        refused: member?.chiefRulesRefused ?? [],
        items,
        answers,
      }),
      // A read and a few calls, not work; but each a judgment made in their name.
      effort: 'medium',
      // Out of every list: Today links it.
      quiet: true,
      commandId: `chief-pass:${pass.id}`,
      chiefPassId: pass.id,
    })
    if (outcome === 'offline') await end('failed')
  } catch (error) {
    console.warn(`chief pass ${pass.id}: did not start: ${String(error)}`)
    await end('failed')
  }
  return pass.id
}

/**
 * A pass thread's events (src/hub/runner-messages.ts): its turn ended or failed. A pass that did
 * not report by then is over: what it did stays, the rest waits on the person.
 */
export async function notePassEvents(
  scope: Scope,
  session: { id: string; chiefPassId: string },
  events: { event: { type: string; retrying?: boolean } }[],
) {
  const ended = events.some(
    ({ event }) =>
      event.type === 'turn.completed' || (event.type === 'error' && event.retrying !== true),
  )
  if (!ended) return
  const { count } = await scoped(scope).chiefPass.updateMany({
    where: { id: session.chiefPassId, status: 'running' },
    data: { status: 'failed', finishedAt: new Date() },
  })
  // Done or not, it is over: out of the way, as its thread was from the start.
  await archivePassThread(scope, session.id)
  if (count) void hubs.get(scope.workspaceId).broadcast(threadUpdated(session.id, 'idle'))
}

// ---------------------------------------------------------------------------
// Chief's calls
// ---------------------------------------------------------------------------

const itemsOf = (value: unknown): Item[] =>
  Array.isArray(value)
    ? value.flatMap((v) => {
        const parsed = ChiefPassItem.safeParse(v)
        return parsed.success ? [parsed.data] : []
      })
    : []

const retried = z.array(
  z.object({ kind: z.literal('retried'), item: z.number(), reason: z.string() }),
)

const PASS_OFF =
  'Their daily pass is over, or they turned it off: nothing more goes in their name. End your turn now, without a reply.'

/**
 * Whether the person still has their pass on. Turned off since it started (setChief stops theirs
 * as it does so; one in another workspace stops here), it is over: failed, as one that stopped.
 */
async function passOn(db: ScopedDb, pass: { id: string; memberId: string }) {
  if (await db.member.count({ where: { id: pass.memberId, chiefPass: true } })) return true
  await db.chiefPass.updateMany({
    where: { id: pass.id, status: 'running' },
    data: { status: 'failed', finishedAt: new Date() },
  })
  return false
}

/** Chief's calls (its tools): a pass's chief_answer, chief_retry and chief_report; chief_rules elsewhere. */
export async function handleChiefCall(
  db: ScopedDb,
  scope: Scope,
  session: {
    id: string
    startedByMemberId: string
    chiefPassId: string | null
  },
  teammate: { id: string; kind: string },
  op: ChiefOperation,
): Promise<object | { error: string }> {
  if (teammate.kind !== 'chief') return { error: 'Only Chief does this.' }
  if (op.name === 'chief_rules') {
    if (session.chiefPassId)
      return {
        error: 'Not in a pass: propose rules in chief_report, and the person takes them on Today.',
      }
    const asker = await askedBy(db, session.id)
    const person = asker === SEVERAL_ASKERS ? null : (asker ?? session.startedByMemberId)
    // Rules give a person's teammates leave to act: written only in a thread of theirs, right after
    // they wrote, never from what a routine, a trigger, an email or another teammate brought in.
    const [thread, last] = await Promise.all([
      db.session.findFirst({
        where: { id: session.id },
        select: { origin: true, parentId: true, playbookRunId: true, quiet: true },
      }),
      db.sessionEvent.findFirst({
        where: { sessionId: session.id, type: 'message.user' },
        orderBy: { seq: 'desc' },
        select: { data: true },
      }),
    ])
    const own =
      thread?.origin === 'member' && !thread.parentId && !thread.playbookRunId && !thread.quiet
    if (person && (!own || (last?.data as { memberId?: string } | null)?.memberId !== person))
      return {
        error:
          'Save their rules only in a thread of theirs, right after they agreed to them in their own words: ask them first.',
      }
    return setRulesByChief(db, scope, person, op.rules)
  }
  if (!session.chiefPassId)
    return { error: `${op.name} is for Chief's daily pass, in the thread Brigade starts for it.` }
  const pass = await db.chiefPass.findFirst({ where: { id: session.chiefPassId } })
  if (!pass) return { error: 'That pass is gone.' }
  if (pass.status !== 'running') return { error: 'This pass is over: end your turn.' }
  if (!(await passOn(db, pass))) return { error: PASS_OFF }
  const items = itemsOf(pass.items)
  const byNumber = (n: number) => items.find((i) => i.n === n)

  if (op.name === 'chief_answer') {
    const item = byNumber(op.item)
    if (item?.kind !== 'question')
      return { error: `Item ${op.item} is no question: only questions are answered.` }
    if (op.option > item.options.length)
      return { error: `Item ${op.item} has ${item.options.length} answers.` }
    if (item.options[op.option - 1]!.design)
      return { error: 'A design is theirs to pick, on its card: leave it to them.' }
    // Only by their own rules: with none, nothing is answered in their name.
    if (!(await personRules(db, pass.memberId))?.text)
      return { error: 'They have no rules yet: answer nothing in their name.' }
    const result = await answerInTheirName(scope, {
      sessionId: item.sessionId,
      memberId: pass.memberId,
      teammateId: item.teammateId,
      askSeq: item.askSeq,
      options: item.options,
      cardQuestion: item.cardQuestion,
      optionIndex: op.option - 1,
      reason: op.reason,
      rule: op.rule,
      passId: pass.id,
    })
    if (result.status === 'off') {
      await passOn(db, pass)
      return { error: PASS_OFF }
    }
    return {
      status: result.status,
      decisionId: result.decisionId,
      next:
        result.status === 'answered'
          ? 'Your answer went to the teammate in their name.'
          : result.status === 'superseded'
            ? 'The person, or the thread, moved on first: nothing went.'
            : result.status === 'escalated'
              ? 'You answered there three times in a row already: it is theirs now. List it in chief_report.'
              : 'It was answered already.',
    }
  }

  if (op.name === 'chief_retry') {
    const item = byNumber(op.item)
    if (item?.kind !== 'failed')
      return { error: `Item ${op.item} did not fail: only failed threads are tried again.` }
    const thread = await loadThread(db, item.sessionId).catch(() => null)
    if (!thread) return { error: 'That thread is gone.' }
    const { retryThread } = await import('./work.js')
    try {
      await retryThread(db, scope, thread, pass.memberId)
    } catch (error) {
      return {
        error:
          error instanceof HTTPException ? error.message : `It could not start: ${String(error)}`,
      }
    }
    await db.$executeRaw`
      UPDATE "ChiefPass" SET actions = actions || ${JSON.stringify([
        { kind: 'retried', item: item.n, reason: op.reason },
      ])}::jsonb
      WHERE id = ${pass.id}`
    return { ok: true, next: 'Its turn starts again.' }
  }

  // chief_report: what is left to the person, once, last.
  const { name: _name, ...report } = op
  const unknown = [
    ...report.decisions.map((d) => d.item),
    ...report.notes.flatMap((n) => (n.item ? [n.item] : [])),
  ].filter((n) => !byNumber(n))
  if (unknown.length) return { error: `No item ${unknown.join(', ')} in your brief.` }
  const { count } = await db.chiefPass.updateMany({
    where: { id: pass.id, status: 'running' },
    data: {
      status: 'done',
      report: report as unknown as Prisma.InputJsonValue,
      finishedAt: new Date(),
    },
  })
  if (count) void hubs.get(scope.workspaceId).broadcast(threadUpdated(session.id, 'idle'))
  return { ok: true, next: 'Reported: end your turn now, without a reply.' }
}

// ---------------------------------------------------------------------------
// What Today shows
// ---------------------------------------------------------------------------

/** What an item is, in a line a person reads. */
function described(item: Item) {
  switch (item.kind) {
    case 'question': {
      const asked =
        item.cardQuestion?.trim() ||
        item.question.trim().split('\n').filter(Boolean).pop() ||
        'a question'
      return `${item.teammate} asks: ${asked.slice(0, 200)}`
    }
    case 'failed':
      return `Stopped on an error: ${item.error.slice(0, 200)}`
    case 'ticket':
      return item.ticket
    case 'pull':
      return `${item.pull} (${item.state})`
  }
}

const threadOf = (item: Item | undefined) =>
  item?.sessionId ? { id: item.sessionId, title: item.title } : null

/** A member's latest pass in this workspace, as Today shows it: null when none ran lately. */
export async function passView(
  db: ScopedDb,
  memberId: string,
  now = new Date(),
): Promise<ChiefPassView | null> {
  const pass = await db.chiefPass.findFirst({
    where: {
      memberId,
      status: { not: 'idle' },
      createdAt: { gte: new Date(now.getTime() - SHOWN_FOR), lte: now },
    },
    orderBy: { createdAt: 'desc' },
    include: {
      // What it settled: never a decision left unsettled (UNSETTLED).
      decisions: {
        where: { status: { notIn: UNSETTLED } },
        orderBy: { createdAt: 'asc' },
        include: { session: { select: { id: true, title: true } } },
      },
    },
  })
  if (!pass) return null
  const items = itemsOf(pass.items)
  const byNumber = (n: number | undefined) =>
    n === undefined ? undefined : items.find((i) => i.n === n)
  const report = ChiefPassReport.safeParse(pass.report ?? {}).data ?? {
    decisions: [],
    notes: [],
    rules: [],
  }
  const member = await db.member.findFirst({
    where: { id: memberId },
    select: { chiefRules: true, chiefRulesRefused: true },
  })
  const answered = new Set(pass.decisions.map((d) => `${d.sessionId}:${d.askSeq}`))
  const decisions: ChiefPassView['decisions'] = []
  for (const d of report.decisions) {
    const item = byNumber(d.item)
    if (!item) continue
    const option =
      item.kind === 'question' && d.option ? (item.options[d.option - 1] ?? null) : null
    const open =
      item.kind === 'question' &&
      !answered.has(`${item.sessionId}:${item.askSeq}`) &&
      !(await questionClosed(db, item.sessionId, item.askSeq))
    decisions.push({
      kind: item.kind,
      thread: threadOf(item),
      what: described(item),
      recommendation: d.recommendation,
      option,
      open,
    })
  }
  return {
    id: pass.id,
    day: pass.day,
    status: pass.status === 'idle' ? 'done' : pass.status,
    threadId: pass.sessionId,
    at: pass.createdAt.toISOString(),
    settled: [
      ...pass.decisions.map((d) => ({
        kind: 'answered' as const,
        thread: { id: d.session.id, title: d.session.title },
        what: optionsOf(d.options)[d.optionIndex ?? -1]?.label ?? '',
        reason: d.reason ?? '',
        rule: d.basis,
        decisionId: d.id,
        status: d.status,
        outcome: d.outcome,
      })),
      ...(retried.safeParse(pass.actions).data ?? []).map((a) => ({
        kind: 'retried' as const,
        thread: threadOf(byNumber(a.item)),
        what: 'Tried its turn again',
        reason: a.reason,
        rule: null,
        decisionId: null,
        status: null,
        outcome: null,
      })),
    ],
    decisions,
    notes: report.notes.map((n) => ({ thread: threadOf(byNumber(n.item)), text: n.text })),
    rules: report.rules.map((r) => ({
      line: r.line,
      why: r.why,
      state: member ? ruleState(member, r.line) : 'proposed',
    })),
  }
}
