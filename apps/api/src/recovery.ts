// What a runner that connects is asked to carry on: turns a restart cut off on
// its computer, and messages it held queued then. The runner says which it lost.
import { randomUUID } from 'node:crypto'
import {
  mentionedIds,
  type AgentEvent,
  type ThreadPrompt,
  type ThreadSpec,
} from '@brigade/contracts'
import { scoped, type ScopedDb } from './db.js'
import {
  currentTeammate,
  loadThread,
  specFor,
  teammateIn,
  type LoadedThread,
} from './thread-spec.js'

type Runner = { organizationId: string; workspaceId: string }

/** A message the API has as queued on a computer, with its latest text. */
export type QueuedMessage = {
  sessionId: string
  messageId: string
  queued: Extract<AgentEvent, { type: 'message.queued' }>
}

/**
 * For each thread in progress (running, or waiting on a person), the spec of
 * the teammate whose turn it is. One that cannot run now (a person has
 * control, no account with usage) is left out: the runner closes it as
 * interrupted when it was running, as before.
 */
export async function turnsToResume(runner: Runner, sessionIds: string[]) {
  const db = scoped(runner)
  const specs: ThreadSpec[] = []
  for (const id of sessionIds) {
    try {
      const thread = await loadThread(db, id)
      if (thread.controlledByMemberId) continue
      specs.push(await specFor(db, thread, { teammate: await turnTeammate(db, thread) }))
    } catch (error) {
      console.warn(`thread ${id}: its turn cannot be continued: ${String(error)}`)
    }
  }
  return specs
}

/**
 * Queued messages as prompts again, in the order they came, each to the
 * teammates it was for. Caps were checked when they were sent. One that cannot
 * go (a person has control, no account) is left out, and the runner cancels it.
 */
export async function messagesToRequeue(runner: Runner, queued: QueuedMessage[]) {
  const db = scoped(runner)
  const threads = new Map<string, LoadedThread | null>()
  const prompts: ThreadPrompt[] = []
  for (const { sessionId, messageId, queued: event } of queued) {
    try {
      if (!threads.has(sessionId))
        threads.set(sessionId, await loadThread(db, sessionId).catch(() => null))
      const thread = threads.get(sessionId)
      if (!thread || thread.controlledByMemberId) continue
      const [first, ...then] = await Promise.all(
        responders(thread, event.text).map((teammate) => specFor(db, thread, { teammate })),
      )
      const ids = new Set(event.attachments?.map((a) => a.id))
      prompts.push({
        type: 'thread.prompt',
        commandId: randomUUID(),
        thread: first!,
        then,
        text: event.text,
        memberId: event.memberId,
        attachments: first!.attachments.filter((a) => ids.has(a.id)),
        messageId,
        ...(event.replyTo ? { replyTo: event.replyTo } : {}),
      })
    } catch (error) {
      console.warn(`thread ${sessionId}: a queued message cannot be queued again: ${String(error)}`)
    }
  }
  return prompts
}

/**
 * Whose turn a running thread is in: the teammate that started the latest
 * turn, or, when a message came after it, the first to answer that message.
 */
async function turnTeammate(db: ScopedDb, thread: LoadedThread) {
  const latest = await db.sessionEvent.findFirst({
    where: { sessionId: thread.id, type: { in: ['turn.started', 'message.user'] } },
    orderBy: { seq: 'desc' },
    select: { data: true },
  })
  const event = latest?.data as AgentEvent | undefined
  if (event?.type === 'turn.started') return teammateIn(thread, event.teammateId)
  return responders(thread, event?.type === 'message.user' ? event.text : '')[0]!
}

/** The teammates a message is for, as when it was sent: those it mentions, else whoever was asked last. */
function responders(thread: LoadedThread, text: string) {
  const mentioned = [...new Set(mentionedIds(text, 'teammate'))].filter((id) =>
    thread.teammates.some((t) => t.teammateId === id),
  )
  return mentioned.length > 0
    ? mentioned.slice(0, 5).map((id) => teammateIn(thread, id))
    : [currentTeammate(thread)]
}
