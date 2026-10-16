// Moving a thread to another computer: from the cloud computer to a member's
// machine and back, as often as they like. A move goes in steps, kept on the
// thread (Session.move) so a restart of the API picks it up where it was:
//   waiting    the thread's turn runs on its computer: it moves once the turn ends
//   releasing  its computer archives the teammates' folders to the bucket and forgets it
//   arriving   it is on the new computer, which gets the message once it is online
// The new computer takes the thread in once per arrival (ThreadSpec.moved): its
// folders from the archives, its conversation from the thread's events, its
// event numbers after the last one. A computer offline when the thread leaves
// keeps its folders: the checkouts still come back from their backups on GitHub.
import { randomUUID } from 'node:crypto'
import { MOVE_PROTOCOL, type ReplyTo, type ThreadAttachmentRef } from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { attachToThread } from './attachments.js'
import { audit } from './audit.js'
import { Prisma, prisma, scoped, type Scope, type ScopedDb } from './db.js'
import { broadcastThreadMove, isOnline, runnerProtocol, sendToRunner } from './hub.js'
import { usableAccounts } from './routes/accounts.js'
import { loadThread, type LoadedThread } from './thread-spec.js'
import { promptThread } from './work.js'

/** The message that goes with a move, as the member sent it. None: the teammate picks up where it was. */
type MovePrompt = {
  text: string
  memberId: string
  teammateIds?: string[]
  attachments: ThreadAttachmentRef[]
  messageId?: string
  replyTo?: ReplyTo
}

export type Move = {
  /** The computer it moves to. */
  to: string
  phase: 'waiting' | 'releasing' | 'arriving'
  /** The member who moved it. */
  by: string
  prompt?: MovePrompt
  /** The thread.release sent to the computer it leaves, while releasing. */
  requestId?: string
  /** When the current step started. */
  since: string
}

/** Archiving a large folder takes a while; past this, the thread moves without what was not handed over. */
const RELEASE_TIMEOUT_MS = 10 * 60_000

const moveOf = (value: unknown) => (value ? (value as Move) : null)

/** A thread runs a turn, or holds one for a person, on its computer: it moves once that ends. */
const busy = (status: string) =>
  status === 'running' || status === 'starting' || status === 'waiting'

/** What a member sees of a computer: its name, "the cloud computer" for the workspace's. */
const label = (computer: { kind: string; name: string }) =>
  computer.kind === 'cloud' ? 'the cloud computer' : computer.name

/**
 * Where a member may move a thread they started: the cloud computer or a machine
 * of theirs, with an account for each of the thread's teammates. Throws why not.
 */
async function checkTarget(db: ScopedDb, thread: LoadedThread, computerId: string) {
  if (computerId === thread.computerId)
    throw new HTTPException(409, { message: 'The thread already runs on this computer' })
  const computer = await db.computer.findFirst({
    where: { id: computerId, status: { not: 'destroyed' } },
  })
  if (
    !computer ||
    (computer.kind === 'member_machine' && computer.memberId !== thread.startedByMemberId)
  )
    throw new HTTPException(404, { message: 'Computer not found' })
  const harnesses = new Set(
    (thread.teammates.length ? thread.teammates.map((t) => t.teammate) : [thread.teammate]).map(
      (t) => t.harness,
    ),
  )
  for (const provider of harnesses) {
    const [account] = await usableAccounts(db, {
      memberId: thread.startedByMemberId,
      computerId,
      provider,
    })
    if (!account)
      throw new HTTPException(409, {
        message: `No ${provider === 'codex' ? 'Codex' : 'Claude'} account of yours on ${label(computer)} is ready. Add or sign in to one under Accounts.`,
      })
  }
  const protocol = runnerProtocol(computerId)
  if (protocol !== undefined && protocol < MOVE_PROTOCOL)
    throw new HTTPException(409, {
      message: `The runner on ${label(computer)} is too old to take a thread in. Update it.`,
    })
  return computer
}

/**
 * Start moving a thread to another computer, with the member's message if
 * any. Only its starter moves it: it runs on their accounts. It moves now, or
 * once the turn running on its computer ends.
 */
export async function requestMove(
  db: ScopedDb,
  scope: Scope & { memberId: string },
  thread: LoadedThread,
  computerId: string,
  message?: Omit<MovePrompt, 'attachments'> & { attachmentIds: string[] },
) {
  if (thread.startedByMemberId !== scope.memberId)
    throw new HTTPException(403, { message: 'Only the member who started the thread can move it' })
  if (thread.controlledByMemberId)
    throw new HTTPException(409, { message: 'Hand the thread back before moving it' })
  if (thread.status === 'waiting')
    throw new HTTPException(409, { message: 'Answer the pending request before moving the thread' })
  if (moveOf(thread.move))
    throw new HTTPException(409, { message: 'This thread is already moving' })
  const computer = await checkTarget(db, thread, computerId)
  let prompt: MovePrompt | undefined
  if (message) {
    const { attachmentIds, ...rest } = message
    const { refs } = await attachToThread(db, scope, thread.id, attachmentIds, {
      memberId: scope.memberId,
    })
    prompt = { ...rest, attachments: refs }
  }
  const move: Move = {
    to: computer.id,
    phase: 'waiting',
    by: scope.memberId,
    ...(prompt ? { prompt } : {}),
    since: new Date().toISOString(),
  }
  // One move at a time, even when two requests race.
  const { count } = await db.session.updateMany({
    where: { id: thread.id, move: { equals: Prisma.AnyNull } },
    data: { move: move as unknown as Prisma.InputJsonValue },
  })
  if (count === 0) throw new HTTPException(409, { message: 'This thread is already moving' })
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: 'thread.move_requested',
    target: { type: 'thread', id: thread.id },
    data: { from: thread.computerId, to: computer.id },
  })
  broadcastThreadMove(scope.workspaceId, thread.id, thread.status)
  await advanceMove(scope, thread.id)
}

/** Steps run one at a time per thread: a turn's end and a runner's answer can come together. */
const steps = new Map<string, Promise<void>>()

/**
 * Take the thread's move as far as it can go now. Called when it is asked
 * for, when a turn ends, when the computer it leaves answers or goes offline,
 * and when the one it goes to comes online.
 */
export function advanceMove(scope: Scope, sessionId: string, released?: { ok: boolean; error?: string }) {
  const next = (steps.get(sessionId) ?? Promise.resolve())
    .then(() => step(scope, sessionId, released))
    .catch((error) => console.error(`thread ${sessionId}: move failed`, error))
  steps.set(sessionId, next)
  void next.finally(() => {
    if (steps.get(sessionId) === next) steps.delete(sessionId)
  })
  return next
}

async function step(scope: Scope, sessionId: string, released?: { ok: boolean; error?: string }) {
  const db = scoped(scope)
  const session = await db.session.findFirst({
    where: { id: sessionId },
    include: { computer: true },
  })
  const move = moveOf(session?.move)
  if (!session || !move) return
  const source = session.computer

  if (move.phase === 'waiting') {
    const online = isOnline(source.id)
    // Its turn goes on there; a computer gone offline mid-turn has nothing to wait for.
    if (online && busy(session.status)) return
    const protocol = runnerProtocol(source.id) ?? 0
    if (!online || protocol < MOVE_PROTOCOL) return arrive(db, scope, session, move, false)
    const teammateIds = (
      await db.threadTeammate.findMany({ where: { sessionId }, select: { teammateId: true } })
    ).map((t) => t.teammateId)
    const requestId = randomUUID()
    await save(db, sessionId, { ...move, phase: 'releasing', requestId, since: new Date().toISOString() })
    const sent = sendToRunner(source.id, {
      type: 'thread.release',
      requestId,
      sessionId,
      teammateIds: teammateIds.length ? teammateIds : [session.teammateId],
    })
    if (!sent) return arrive(db, scope, session, move, false)
    // A runner that never answers does not hold the thread for good.
    setTimeout(() => {
      void advanceMove(scope, sessionId, { ok: false, error: 'timed out' })
    }, RELEASE_TIMEOUT_MS).unref?.()
    return
  }

  if (move.phase === 'releasing') {
    const timedOut = Date.now() - new Date(move.since).getTime() >= RELEASE_TIMEOUT_MS
    // Still archiving, and still there: its answer moves it on.
    if (!released && !timedOut && isOnline(source.id)) return
    if (released && !released.ok)
      console.warn(`thread ${sessionId}: ${source.name} could not hand it over: ${released.error}`)
    return arrive(db, scope, session, move, released?.ok ?? false)
  }

  // Arriving: the new computer gets the message once its runner is online.
  if (session.computerId !== move.to) return
  await deliver(db, scope, sessionId, move)
}

/** The thread is now the new computer's: its next turn runs there. */
async function arrive(
  db: ScopedDb,
  scope: Scope,
  session: { id: string; computerId: string; lastSeq: number; computer: { kind: string; name: string } },
  move: Move,
  handedOver: boolean,
) {
  const target = await db.computer.findFirst({ where: { id: move.to } })
  if (!target) {
    await save(db, session.id, null)
    broadcastThreadMove(scope.workspaceId, session.id, 'idle')
    return
  }
  const arriving: Move = { ...move, phase: 'arriving', since: new Date().toISOString() }
  delete arriving.requestId
  // The new computer numbers its events after every one stored, gaps left by the old one included.
  const last = await db.sessionEvent.findFirst({
    where: { sessionId: session.id },
    orderBy: { seq: 'desc' },
    select: { seq: true },
  })
  const seq = Math.max(session.lastSeq, last?.seq ?? 0)
  await db.session.updateMany({
    where: { id: session.id },
    data: {
      computerId: target.id,
      // The starter's account there is picked with the next turn (specFor).
      accountId: null,
      movedAt: new Date(),
      movedFrom: label(session.computer),
      movedSeq: seq,
      lastSeq: seq,
      move: arriving as unknown as Prisma.InputJsonValue,
      // What ran on the old computer ended there.
      status: 'idle',
    },
  })
  await audit({
    ...scope,
    actor: { type: 'member', id: move.by },
    action: 'thread.moved',
    target: { type: 'thread', id: session.id },
    data: { from: session.computerId, to: target.id, handedOver },
  })
  broadcastThreadMove(scope.workspaceId, session.id, 'idle')
  await deliver(db, scope, session.id, arriving)
}

/** Send the move's message (or a nudge to carry on) to the thread on its new computer. */
async function deliver(db: ScopedDb, scope: Scope, sessionId: string, move: Move) {
  const thread = await loadThread(db, sessionId)
  const outcome = await promptThread(
    db,
    scope,
    thread,
    move.prompt
      ? {
          text: move.prompt.text,
          memberId: move.prompt.memberId,
          ...(move.prompt.teammateIds?.length ? { teammateIds: move.prompt.teammateIds } : {}),
          attachments: move.prompt.attachments,
          ...(move.prompt.messageId ? { messageId: move.prompt.messageId } : {}),
          ...(move.prompt.replyTo ? { replyTo: move.prompt.replyTo } : {}),
        }
      : // Nobody wrote anything: the teammate is told the thread so far and carries on.
        { text: '', memberId: null, handoff: true },
  ).catch((error: unknown) => {
    // No account there any more, say: the thread stays there, without the message.
    console.warn(`thread ${sessionId}: the moved message did not go: ${String(error)}`)
    return 'failed' as const
  })
  // A member's machine still offline: it goes when its runner connects (movesArriving).
  if (outcome === 'offline') return
  await save(db, sessionId, null)
  broadcastThreadMove(scope.workspaceId, sessionId, outcome === 'paused' ? 'paused' : thread.status)
}

const save = (db: ScopedDb, sessionId: string, move: Move | null) =>
  db.session.updateMany({
    where: { id: sessionId },
    data: { move: move ? (move as unknown as Prisma.InputJsonValue) : Prisma.DbNull },
  })

/** A runner answered thread.release: the thread moves on, with its folders or without. */
export async function onReleased(
  runner: Scope & { computerId: string },
  result: { requestId: string; ok: boolean; error?: string },
) {
  const session = await prisma.session.findFirst({
    where: { computerId: runner.computerId, move: { path: ['requestId'], equals: result.requestId } },
    select: { id: true, organizationId: true, workspaceId: true },
  })
  if (!session) return
  await advanceMove(session, session.id, { ok: result.ok, ...(result.error ? { error: result.error } : {}) })
}

/**
 * Moves that may go on now a computer's runner connected or left, or a
 * thread on it went quiet: those leaving it, and those arriving on it.
 */
export async function movesOn(computerId: string, sessionId?: string) {
  const sessions = await prisma.session.findMany({
    where: {
      ...(sessionId ? { id: sessionId } : {}),
      NOT: { move: { equals: Prisma.AnyNull } },
      OR: [{ computerId }, { move: { path: ['to'], equals: computerId } }],
    },
    select: { id: true, organizationId: true, workspaceId: true },
  })
  for (const s of sessions) await advanceMove(s, s.id)
}

/** What a member sees of a move in progress: where to, and how far. */
export function movePublic(value: unknown) {
  const move = moveOf(value)
  return move ? { to: move.to, phase: move.phase, since: move.since } : null
}
