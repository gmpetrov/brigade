// Threads a teammate starts that go on by themselves, at the top level (docs/hand-offs.md):
// start_thread hands work to a teammate, itself or another, in a thread of its own; message_thread
// writes later in such a thread, or in one of the caller's own children. They replaced the Tasks
// board's create_task and its comments. A thread started so runs on the accounts of the calling
// thread's starter, on its computer, for whoever asked there, and says who started it and from
// where (Session.startedFromId).
import {
  startedThreadBrief,
  threadComment,
  WAKEUPS_IN_A_ROW,
  type ScheduleOperation,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { memberMayWrite } from './account-sharing.js'
import { audit } from './audit.js'
import { markOnChiefsWord } from './chief-answers.js'
import { messageChild } from './children.js'
import type { Scope, ScopedDb } from './db.js'
import { pickLines, projectOf } from './lists.js'
import { usableProject } from './projects.js'
import { reopenThread } from './thread-done.js'
import { askedBy, findTeammate, loadThread, noSuchTeammate } from './thread-spec.js'
import { firedInARow } from './wakeups.js'
import { promptThread, startThread } from './work.js'

type StartedThreadOperation = Extract<ScheduleOperation, { name: 'start_thread' | 'message_thread' }>

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

/**
 * Write in a thread this one started (start_thread), headed with who wrote it and from where: its
 * teammate reads it and answers there. Or in a child of this one (messageChild), which carries
 * on and reports again. Nowhere else.
 */
export async function messageThread(
  db: ScopedDb,
  scope: Scope,
  session: Caller,
  teammate: { id: string; name: string },
  op: { threadId: string; text: string },
): Promise<object | { error: string }> {
  if (op.threadId === session.id) return { error: 'That is this thread: just reply here.' }
  const started = session.playbookRunId
    ? null
    : await db.session.findFirst({
        where: { id: op.threadId, startedFromId: session.id },
        select: { id: true },
      })
  if (!started) return messageChild(db, scope, session, teammate, op.threadId, op.text)
  const target = await loadThread(db, started.id)
  // As a message from this thread's person would: only where they may write.
  if (!(await memberMayWrite(target, session.startedByMemberId)))
    return { error: "The person in this thread may not write in that one: it is someone else's." }
  if (target.controlledByMemberId)
    return { error: 'A person has control of that thread right now. Try again later.' }
  // Written on Chief's word: the work it asks for there goes on it too.
  await markOnChiefsWord(db, target.id, session)
  const outcome = await promptThread(db, scope, target, {
    text: threadComment({ from: teammate.name, threadTitle: session.title, text: op.text }),
    memberId: null,
    // Whoever asked for it here asks in that thread too.
    onBehalfOf: await askedBy(db, session.id),
    // The teammate it was started for, while it is in it.
    ...(target.teammates.some((t) => t.teammateId === target.teammateId)
      ? { teammateIds: [target.teammateId] }
      : {}),
  })
  if (outcome === 'offline') return { error: "That thread's computer is offline." }
  // New work in it: it is no longer done.
  await reopenThread(scope, target.id)
  await audit({
    ...scope,
    actor: { type: 'teammate', id: teammate.id },
    action: 'thread.messaged',
    target: { type: 'thread', id: target.id },
    data: { fromId: session.id },
  })
  return { ok: true, note: 'Posted to that thread; its teammate reads it and answers there.' }
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
