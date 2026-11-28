// Threads a teammate starts that go on by themselves, at the top level (docs/hand-offs.md):
// start_thread hands work to a teammate, itself or another, in a thread of its own; message_thread
// writes later in such a thread, or in one of the caller's own children. They replaced the Tasks
// board's create_task and its comments. A thread started so runs on the accounts of the calling
// thread's starter, on its computer, for whoever asked there, and says who started it and from
// where (Session.startedFromId).
import {
  startedThreadBrief,
  threadComment,
  treeMessage,
  type TreeRelation,
  WAKEUPS_IN_A_ROW,
  type ScheduleOperation,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { memberMayWrite } from './account-sharing.js'
import { trackAudit } from './analytics.js'
import { audit } from './audit.js'
import { markOnChiefsWord } from './chief-answers.js'
import { machineRefusal, messageChild } from './children.js'
import { prisma, type Scope, type ScopedDb } from './db.js'
import { pickLines, projectOf } from './lists.js'
import { usableProject } from './projects.js'
import { setThreadArchived } from './thread-archive.js'
import { reopenThread } from './thread-done.js'
import { askedBy, findTeammate, loadThread, noSuchTeammate } from './thread-spec.js'
import { firedInARow } from './wakeups.js'
import { promptThread, startThread } from './work.js'
import { missionIdOfThread } from './initiatives.js'

type StartedThreadOperation = Extract<
  ScheduleOperation,
  { name: 'start_thread' | 'message_thread' }
>

export const isStartedThreadOperation = (op: ScheduleOperation): op is StartedThreadOperation =>
  op.name === 'start_thread' || op.name === 'message_thread'

/** The thread calling, as handleScheduleCall reads it. */
type Caller = {
  id: string
  title: string
  startedByMemberId: string
  projectId: string | null
  playbookRunId: string | null
  chiefWordSeq: number | null
  /** Its parent, when it is a sub-thread, and the thread at the top of its tree (docs/sub-threads.md). */
  parentId?: string | null
  rootId?: string | null
}

type Teammate = Parameters<typeof pickLines>[3]

/** A project by id or name, or null for none. */
async function findProject(db: ScopedDb, ref: string | null) {
  if (ref === null) return null
  const project =
    (await db.project.findFirst({ where: { id: ref }, select: { id: true } })) ??
    (await db.project.findFirst({
      where: { name: { equals: ref.trim(), mode: 'insensitive' } },
      select: { id: true },
    }))
  if (!project)
    throw new HTTPException(404, {
      message: 'No project has that id or name; your instructions list the projects',
    })
  return (await usableProject(db, project.id)) ?? null
}

/**
 * A thread for a teammate (itself by default), at the top: a goal of its own, work for another
 * teammate, lines of a list. Not from a playbook's run, whose work stays inside it (a child).
 */
export async function startThreadFrom(
  db: ScopedDb,
  scope: Scope,
  session: Caller,
  teammate: Teammate,
  op: Extract<StartedThreadOperation, { name: 'start_thread' }>,
): Promise<object | { error: string }> {
  if (session.playbookRunId)
    return {
      error:
        "A playbook's run hands no work outside it: start a child thread (start_child) for it instead.",
    }
  if ((await firedInARow(db, session.id)) >= WAKEUPS_IN_A_ROW)
    return {
      error:
        `You were woken ${WAKEUPS_IN_A_ROW} times in a row in this thread with no word from a person. ` +
        'Start no more work: tell the person where things stand, or open a ticket if you need them.',
    }
  if (!op.list !== !op.items)
    return { error: 'Give the list (its library path) and the lines of it the thread works on.' }
  const ref = op.teammate?.trim()
  const assignee = ref
    ? await findTeammate(db, ref)
    : await db.teammate.findFirst({ where: { id: teammate.id } })
  if (!assignee) return { error: await noSuchTeammate(db, ref ?? teammate.name) }
  try {
    // The project asked; else the one whose folder holds the list; else this thread's.
    const projectId =
      op.project !== undefined
        ? await findProject(db, op.project)
        : ((op.list ? await projectOf(db, op.list) : null) ?? session.projectId)
    const lines =
      op.list && op.items ? await pickLines(db, scope, session, teammate, op.list, op.items) : null
    if (lines && 'error' in lines) return lines
    const from = await loadThread(db, session.id)
    const { thread, outcome } = await startThread(db, scope, {
      teammate: assignee,
      computer: from.computer,
      memberId: session.startedByMemberId,
      title: op.title,
      text: startedThreadBrief({
        from: teammate.name,
        threadTitle: session.title,
        title: op.title,
        brief: op.brief,
      }),
      byTeammateId: teammate.id,
      startedFromId: session.id,
      // Started by a teammate, for whoever asked it here.
      askedByMemberId: await askedBy(db, session.id),
      ...(lines ? { listItemIds: lines.ids } : {}),
      projectId,
      // Started from a mission's thread, it is the mission's too (docs/missions.md).
      initiativeId: await missionIdOfThread(db, session.id),
      // Started on Chief's word: its work goes on it too (src/chief-answers.ts).
      chiefWord: session.chiefWordSeq != null,
    })
    if (outcome === 'offline')
      return { error: 'This computer is offline; the thread could not start.' }
    return {
      threadId: thread.id,
      title: thread.title,
      teammate: assignee.name,
      ...(lines ? { items: lines.texts } : {}),
      note:
        `${assignee.id === teammate.id ? 'You start' : `${assignee.name} starts`} on it in a thread ` +
        'of its own, in the sidebar. Tell the person in a line what went where, by its title. To add ' +
        'to it later, message_thread with this threadId.',
    }
  } catch (error) {
    if (error instanceof HTTPException) return { error: error.message }
    throw error
  }
}

/** Messages from other threads in a row, with no word from a person, that a thread takes. */
export const COMMENTS_IN_A_ROW = 5
/** How far back they count: a ping-pong between two threads is quick. */
const COMMENTS_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Take a place for one more message from another thread (thread.messaged in the audit log), or
 * null when the thread was sent COMMENTS_IN_A_ROW since a person last wrote in it (in the last
 * day): two threads writing to each other with nobody in between stop. Counted from the places
 * taken, not from the thread's events, which its runner writes later (a message queued behind a
 * turn is not one yet); under the thread's lock, so two sends at once cannot take the same place.
 */
async function takeCommentPlace(
  scope: Scope,
  targetId: string,
  entry: { teammateId: string; fromId: string },
) {
  // The thread was found in this workspace (scoped) before: its own events and log entries.
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`comments:${targetId}`}, 0))`
    const messages = await tx.sessionEvent.findMany({
      where: { sessionId: targetId, type: { in: ['message.user', 'message.queued'] } },
      orderBy: { seq: 'desc' },
      take: 200,
      select: { data: true, at: true },
    })
    type Said = { memberId?: string | null; messageId?: string }
    const person = messages.find((m) => (m.data as Said).memberId)
    // One word from a person counts once: its runner records it queued, then again as it is read.
    const personId = person && (person.data as Said).messageId
    const said = personId
      ? Math.min(
          ...messages
            .filter((m) => (m.data as Said).messageId === personId)
            .map((m) => m.at.getTime()),
        )
      : (person?.at.getTime() ?? 0)
    const since = new Date(Math.max(said, Date.now() - COMMENTS_WINDOW_MS))
    const counted = { workspaceId: scope.workspaceId, at: { gt: since }, targetId }
    const places = await tx.auditEntry.findMany({
      where: { ...counted, action: 'thread.messaged' },
      select: { id: true },
    })
    // Places given back (not sent): the log is append-only, so each has an entry of its own.
    const unsent = await tx.auditEntry.findMany({
      where: { ...counted, action: 'thread.message_unsent' },
      select: { data: true },
    })
    const given = new Set(unsent.map((u) => (u.data as { placeId?: string } | null)?.placeId))
    const taken = places.filter((p) => !given.has(String(p.id))).length
    if (taken >= COMMENTS_IN_A_ROW) return null
    return tx.auditEntry.create({
      data: {
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
        actorType: 'teammate',
        actorId: entry.teammateId,
        action: 'thread.messaged',
        targetType: 'thread',
        targetId,
        data: { fromId: entry.fromId },
      },
      select: { id: true },
    })
  })
}

/**
 * A thread at the top this teammate works in, other than the caller: one a person gave it, or
 * one it is in with another, archived or not (written in, it comes back, as when a person writes
 * there). Not a child (its parent tells it more), nor a playbook's run.
 */
function ownThread(db: ScopedDb, teammateId: string, threadId: string) {
  return db.session.findFirst({
    where: {
      id: threadId,
      parentId: null,
      playbookRunId: null,
      teammates: { some: { teammateId } },
    },
    select: { id: true },
  })
}

const NOWHERE =
  'message_thread writes only in the threads of your own tree (your parent, your sub-threads and ' +
  'theirs, your siblings), the threads you started (start_thread) and the other threads at the top ' +
  'you are a teammate of.'

/** The thread at the top of a thread's tree: itself at the top (two levels at most, SUBTHREAD_DEPTH). */
async function treeRoot(
  db: ScopedDb,
  t: { id: string; parentId?: string | null; rootId?: string | null },
) {
  if (t.rootId) return t.rootId
  if (!t.parentId) return t.id
  const parent = await db.session.findFirst({
    where: { id: t.parentId },
    select: { parentId: true, rootId: true },
  })
  return parent?.rootId ?? parent?.parentId ?? t.parentId
}

/**
 * Where a thread of the same tree as `session` sits, seen from it (the relation the message it
 * receives says, treeMessage): the sender is its parent, its child, its sibling (same parent), or
 * another thread of the tree. Null for a thread of another tree, or for this one.
 */
export async function treeRelation(
  db: ScopedDb,
  session: { id: string; parentId?: string | null; rootId?: string | null },
  threadId: string,
): Promise<TreeRelation | null> {
  if (threadId === session.id) return null
  const target = await db.session.findFirst({
    where: { id: threadId },
    select: { id: true, parentId: true, rootId: true },
  })
  if (!target) return null
  const [mine, theirs] = await Promise.all([treeRoot(db, session), treeRoot(db, target)])
  if (mine !== theirs) return null
  if (target.parentId === session.id) return 'parent'
  if (session.parentId === target.id) return 'child'
  if (target.parentId && target.parentId === session.parentId) return 'sibling'
  return 'tree'
}

/**
 * A thread this one may write in with message_thread (and follow, follow_thread), and how: one it
 * started (start_thread), its own child (messageChild), another thread of its tree, or a thread at
 * the top its teammate works in. A playbook's run, only within its own tree. Null for any other.
 * Who may write there is checked when it is written in.
 */
export async function writableThread(
  db: ScopedDb,
  session: Pick<Caller, 'id' | 'playbookRunId' | 'parentId' | 'rootId'>,
  teammate: { id: string },
  threadId: string,
): Promise<
  | { kind: 'started' | 'mine' | 'child'; id: string }
  | { kind: 'tree'; id: string; relation: TreeRelation }
  | null
> {
  if (threadId === session.id) return null
  // A playbook's run writes only in its own tree: what started it is untrusted.
  const started = session.playbookRunId
    ? null
    : await db.session.findFirst({
        where: { id: threadId, startedFromId: session.id },
        select: { id: true },
      })
  if (started) return { kind: 'started', id: started.id }
  const relation = await treeRelation(db, session, threadId)
  // A child of this thread is told more as a child (messageChild).
  if (relation === 'parent') return { kind: 'child', id: threadId }
  if (relation) return { kind: 'tree', id: threadId, relation }
  if (session.playbookRunId) return null
  const mine = await ownThread(db, teammate.id, threadId)
  return mine ? { kind: 'mine', id: mine.id } : null
}

/**
 * Whether the people of a thread (its starter, and whoever asked in it when that is another) may
 * write in `target`: what a message from it there, or its following that thread, needs.
 */
export async function peopleMayWrite(
  db: ScopedDb,
  session: { id: string; startedByMemberId: string },
  target: { startedByMemberId: string | null; othersMayPrompt: boolean; computerId: string },
) {
  const asker = await askedBy(db, session.id)
  for (const memberId of new Set([session.startedByMemberId, ...(asker ? [asker] : [])]))
    if (!(await memberMayWrite(target, memberId))) return false
  return true
}

/**
 * Why message_thread may not write in a thread: said plainly, so the teammate knows what to do.
 * Only about a thread this thread's people may write in (and a parent named only when they may
 * write there too): of one they may not, nothing is said, not even that it exists.
 */
async function refusal(
  db: ScopedDb,
  session: Caller,
  teammate: { id: string; name: string },
  threadId: string,
): Promise<{ error: string }> {
  if (session.playbookRunId)
    return {
      error:
        "A playbook's run writes only in its own child threads (list_children): that is not one of them.",
    }
  const access = { startedByMemberId: true, othersMayPrompt: true, computerId: true } as const
  const thread = await db.session.findFirst({
    where: { id: threadId },
    select: {
      ...access,
      parentId: true,
      playbookRunId: true,
      parent: { select: { ...access, id: true, title: true } },
      teammates: { select: { teammate: { select: { id: true, name: true } } } },
    },
  })
  const asker = await askedBy(db, session.id)
  const people = [...new Set([session.startedByMemberId, ...(asker ? [asker] : [])])]
  const open = async (t: Parameters<typeof memberMayWrite>[0]) => {
    for (const memberId of people) if (!(await memberMayWrite(t, memberId))) return false
    return true
  }
  if (!thread || !(await open(thread)))
    return { error: `That is not a thread you may write in. ${NOWHERE}` }
  if (thread.parent)
    return {
      error: (await open(thread.parent))
        ? `That is a sub-thread of “${thread.parent.title}” (${thread.parent.id}): only that ` +
          'thread tells it more. Write there instead, if you work in it.'
        : "That is another thread's sub-thread: only its parent tells it more.",
    }
  if (thread.playbookRunId)
    return { error: "That is a playbook's run: only the thread it reports to writes in it." }
  const others = thread.teammates.filter((t) => t.teammate.id !== teammate.id)
  const names = others.map((t) => t.teammate.name)
  return {
    error:
      `You (${teammate.name}) are not a teammate of that thread` +
      (names.length ? `: ${names.join(', ')} ${names.length > 1 ? 'are' : 'is'}. ` : '. ') +
      `${NOWHERE} Tell the person here what that thread should know.`,
  }
}

/**
 * Write in a thread this one started (start_thread), or in a thread at the top this teammate works
 * in too, headed with who wrote it and from where: its teammate reads it and answers there. Or in
 * a child of this one (messageChild), which carries on and reports again. Nowhere else.
 */
export async function messageThread(
  db: ScopedDb,
  scope: Scope,
  session: Caller,
  teammate: { id: string; name: string },
  op: { threadId: string; text: string },
): Promise<object | { error: string }> {
  if (op.threadId === session.id) return { error: 'That is this thread: just reply here.' }
  const found = await writableThread(db, session, teammate, op.threadId)
  if (!found) return refusal(db, session, teammate, op.threadId)
  // A child of this thread is told more as a child: it carries on and reports again.
  if (found.kind === 'child') return messageChild(db, scope, session, teammate, found.id, op.text)
  const mine = found.kind === 'mine'
  // A pull request's review is asked to look again by the thread whose pull request it reads.
  if (
    found.kind === 'tree' &&
    (await db.pullRequest.findFirst({
      where: {
        OR: [{ reviewSessionId: found.id }, { reviews: { some: { sessionId: found.id } } }],
      },
      select: { id: true },
    }))
  )
    return {
      error:
        'That thread reviews a pull request: only the thread that opened it asks it to look again. Write to that thread instead.',
    }
  const target = await loadThread(db, found.id)
  // As a message from this thread's person would: only where they may write. And from whoever
  // asked for it here, when that is another (a thread shared with them): they ask there too.
  const asker = await askedBy(db, session.id)
  if (!(await peopleMayWrite(db, session, target)))
    return {
      error: "The person in this thread may not write in that one: it is someone else's.",
    }
  if (target.controlledByMemberId)
    return { error: 'A person has control of that thread right now. Try again later.' }
  // On a member's own machine, in its tree: only on that member's word (start_child's `mine`).
  if (found.kind === 'tree') {
    const machine = await machineRefusal(db, session, target)
    if (machine) return { error: machine }
  }
  const place = await takeCommentPlace(scope, target.id, {
    teammateId: teammate.id,
    fromId: session.id,
  })
  if (!place)
    return {
      error:
        `That thread was sent ${COMMENTS_IN_A_ROW} messages from other threads in a row with no word ` +
        'from a person. Write there no more: tell the person here where things stand.',
    }
  // Not sent (refused, offline): its place is free again.
  const free = () =>
    audit({
      ...scope,
      actor: { type: 'teammate', id: teammate.id },
      action: 'thread.message_unsent',
      target: { type: 'thread', id: target.id },
      data: { placeId: String(place.id), fromId: session.id },
    })
  let outcome: Awaited<ReturnType<typeof promptThread>>
  try {
    // Written in again, an archived thread is back in the sidebar, as when a person writes there.
    // Before the message goes: failing here, nothing went, and trying again sends it once. Not put
    // away again if the message does not go: a person may have written there meanwhile, and a
    // thread left in sight loses nothing.
    if (target.archivedAt) await setThreadArchived(scope, target.id, false)
    // Written on Chief's word: the work it asks for there goes on it too.
    await markOnChiefsWord(db, target.id, session)
    outcome = await promptThread(db, scope, target, {
      // Within a tree, it says the relation, as a parent's notes always did (docs/sub-threads.md).
      text:
        found.kind === 'tree'
          ? treeMessage({
              from: teammate.name,
              relation: found.relation,
              title: session.title,
              text: op.text,
            })
          : threadComment({ from: teammate.name, threadTitle: session.title, text: op.text }),
      memberId: null,
      // Whoever asked for it here asks in that thread too.
      onBehalfOf: asker,
      // This teammate, in a thread of its own; else the one it was started for, while it is in it.
      ...(mine
        ? { teammateIds: [teammate.id] }
        : target.teammates.some((t) => t.teammateId === target.teammateId)
          ? { teammateIds: [target.teammateId] }
          : {}),
    })
  } catch (error) {
    // Refused before it was taken in (a thread moving, a runner too old), or the thread could not
    // be brought back: nothing went.
    await free()
    throw error
  }
  if (outcome === 'offline') {
    await free()
    return { error: "That thread's computer is offline." }
  }
  // The message went: it must not be reported as failed, which a retry would send again.
  // New work in it: it is no longer done.
  await reopenThread(scope, target.id).catch((error: unknown) =>
    console.warn(`message_thread to ${target.id}: sent, but not reopened: ${String(error)}`),
  )
  // Its audit entry is the place taken above; its analytics go now.
  trackAudit({
    ...scope,
    actor: { type: 'teammate', id: teammate.id },
    action: 'thread.messaged',
    target: { type: 'thread', id: target.id },
    data: { fromId: session.id },
  })
  return {
    ok: true,
    note:
      found.kind === 'tree'
        ? `Posted to that thread of your tree (you are its ${found.relation === 'tree' ? 'relative in the tree' : found.relation}); its teammate reads it and goes on there. A sub-thread reports to its own parent as before.`
        : 'Posted to that thread; its teammate reads it and answers there.',
  }
}

/** start_thread and message_thread, from handleScheduleCall. */
export function handleStartedThreadCall(
  db: ScopedDb,
  scope: Scope,
  session: Caller,
  teammate: Teammate,
  op: StartedThreadOperation,
) {
  return op.name === 'start_thread'
    ? startThreadFrom(db, scope, session, teammate, op)
    : messageThread(db, scope, session, teammate, op)
}
