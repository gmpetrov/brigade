// Runs threads on this computer: one harness session per teammate in a thread,
// turns of a thread in order (several teammates answer one after another), and
// at most `concurrency` turns at once across threads. A member's message that
// comes in while the thread is busy waits in its queue, shown as queued, until
// its turn starts; meanwhile it can be cancelled, edited or steered into the running turn.
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  attachmentLines,
  mentionedIds,
  MessageAttachment,
  type AgentEvent,
  type ApiToRunner,
  type RunnerToApi,
  type ThreadAttachmentRef,
  type ThreadSpec,
} from '@brigade/contracts'
import type { Attachments, Folder } from './attachments.js'
import type { Previews } from './previews.js'
import { memoryPrompt, parseMemory } from './memory.js'
import { CLOUD, paths } from './config.js'
import { teammateHome, teammateUser } from './teammates.js'
import {
  HarnessThread,
  runOnce,
  type ConnectorCaller,
  type CredentialRequester,
  type ThreadContext,
  type ThreadInput,
} from './harness/index.js'

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/
/** Park an idle harness session after this long; the next message resumes it. */
const PARK_AFTER_MS = 5 * 60_000
/** How much of what others said a teammate is told at the start of its turn. */
const CATCH_UP_CHARS = 40_000
const LOG_ENTRIES = 200
/** Teammates handing the thread to one another stop after this many handoffs without a member. */
const MAX_HANDOFFS = 40
/** A thread this long without a turn has gone quiet: its memory is taken then. */
const QUIET_AFTER_MS = Number(process.env.BRIGADE_QUIET_MS) || PARK_AFTER_MS
/** Longest a memory run may take. */
const MEMORY_RUN_MS = 4 * 60_000
/** Events after which a thread is no longer running a turn. */
const OUT_OF_TURN = new Set<AgentEvent['type']>([
  'turn.completed',
  'error',
  'approval.requested',
  'question.asked',
  'ticket.opened',
  'control.changed',
  'account.switched',
])

type Command = Extract<
  ApiToRunner,
  {
    type:
      | 'thread.prompt'
      | 'thread.approval'
      | 'thread.answer'
      | 'thread.ticket'
      | 'thread.interrupt'
      | 'thread.queued'
  }
>

type Seat = {
  harness: HarnessThread
  folder: Folder
  parkTimer: NodeJS.Timeout | undefined
  reply?: string
}

/**
 * A member's message, from when it comes in until a teammate reads it. queued:
 * waits for the turns before it. held: its teammate waits on a person (an
 * approval, a question, a ticket); it runs once they answer. steering: being
 * given to the running turn. Then it is shown (its turn started), steered or cancelled.
 */
type Message = {
  id: string
  /** The teammate that answers first, then the others, in order. */
  specs: ThreadSpec[]
  text: string
  memberId: string | null
  attachments: ThreadAttachmentRef[]
  state: 'queued' | 'held' | 'steering' | 'shown' | 'steered' | 'cancelled'
  /** Settles when a steer in progress is done, either way. */
  steering?: Promise<void>
  /** The log's end just after it, once shown. */
  upTo?: Promise<number>
}

/** Who said what in a thread, so each teammate can be told what it missed. Never a credential. */
type Log = {
  /** Index of entries[0] since the thread began; older entries are dropped. */
  start: number
  entries: { by: string | null; name: string; text: string }[]
  /** Per teammate: the index up to which it has been told. */
  seen: Record<string, number>
  /** The index up to which memory was taken, and the thread's summary then. */
  memorized?: number
  summary?: string
}

type Thread = {
  /** One harness session per teammate, by teammate id, and where it works. */
  harnesses: Map<string, Seat>
  queue: Promise<void>
  controller: AbortController | undefined
  /** The turn running now, and whose. */
  running?: { teammateId: string; turnId: string }
  /** Messages not yet read: queued, held or being steered, by id. */
  messages: Map<string, Message>
  /** A memory run is queued or running: a new message waits for it. */
  memorizing: boolean
  /** Set while a person holds control: no teammate acts in the thread. */
  takeover?: { memberId: string; since: number }
  log: Promise<Log>
  /** Turns queued and not yet started, by teammate id. */
  waiting: Map<string, number>
  /** Handoffs since a member last wrote. */
  handoffs: number
  /** Fires when the thread goes quiet, to take its memory. */
  quietTimer?: NodeJS.Timeout
  /** The latest turn's spec: the account and teammates a memory run uses. */
  lastSpec?: ThreadSpec
}

export class Threads {
  private threads = new Map<string, Thread>()
  private running = 0
  /** Turns queued or running, across threads. */
  private pending = 0
  private waiters: Array<() => void> = []

  constructor(
    private readonly options: {
      concurrency: number
      emit: (sessionId: string, event: AgentEvent) => void
      callConnector: (
        sessionId: string,
        teammateId: string,
        call: Parameters<ConnectorCaller>[0],
      ) => Promise<{ output: unknown; attachments: ThreadAttachmentRef[] }>
      /** The thread's files, put in each teammate's working folder. */
      attachments: Pick<Attachments, 'deliver'>
      requestCredential: (
        sessionId: string,
        teammateId: string,
        request: Parameters<CredentialRequester>[0],
      ) => Promise<unknown>
      /** A teammate's reply mentioned others in the thread: ask the API to have them answer next. */
      handoff: (sessionId: string, fromTeammateId: string, teammateIds: string[]) => void
      /** The library and memory threads reach. */
      context: Omit<ThreadContext, 'callLibrary' | 'callTask' | 'callSchedule' | 'preview'>
      /** Apps teammates run for people to try, one per thread. */
      previews: Previews
      callLibrary: (
        sessionId: string,
        teammateId: string,
        call: Parameters<ThreadContext['callLibrary']>[0],
      ) => Promise<unknown>
      /** A teammate's task tools: create a task from the thread, or complete its task. */
      callTask: (
        sessionId: string,
        teammateId: string,
        call: Parameters<ThreadContext['callTask']>[0],
      ) => Promise<unknown>
      /** A teammate's schedule tools: create, list or change its schedules. */
      callSchedule: (
        sessionId: string,
        teammateId: string,
        call: Parameters<ThreadContext['callSchedule']>[0],
      ) => Promise<unknown>
      /** What a quiet thread leaves in memory. */
      memoryUpdate: (update: Extract<RunnerToApi, { type: 'memory.update' }>) => void
    },
  ) {}

  handle(command: Command) {
    if (command.type === 'thread.interrupt') {
      const thread = this.threads.get(command.sessionId)
      // An interrupt meant for a turn that already ended does not stop the next one.
      if (thread && (!command.turnId || thread.running?.turnId === command.turnId))
        thread.controller?.abort()
      return
    }
    if (command.type === 'thread.queued') return this.queued(command)
    const spec = command.thread
    const specs = command.type === 'thread.prompt' ? [spec, ...command.then] : [spec]
    if (!SAFE_ID.test(spec.sessionId) || specs.some((s) => !SAFE_ID.test(s.teammate.id)))
      throw new Error('Invalid thread id')
    const at = new Date().toISOString()
    if (this.threads.get(spec.sessionId)?.takeover) {
      const reason = 'A person has control of this thread. Hand it back first.'
      if (command.type === 'thread.prompt' && command.messageId && !command.handoff)
        this.options.emit(spec.sessionId, {
          at,
          type: 'message.cancelled',
          messageId: command.messageId,
          memberId: command.memberId,
          reason,
        })
      else this.options.emit(spec.sessionId, { at, type: 'raw', source: 'runner', value: reason })
      return
    }
    if (command.type === 'thread.prompt' && command.handoff) {
      // Nobody wrote anything: each is told what was said since its last turn.
      for (const next of specs) this.enqueue(next, 'prompt')
      return
    }
    if (command.type === 'thread.prompt') {
      const thread = this.thread(spec.sessionId)
      thread.handoffs = 0
      const message: Message = {
        id: command.messageId ?? randomUUID(),
        specs,
        text: command.text,
        memberId: command.memberId,
        attachments: command.attachments,
        state: 'queued',
      }
      // Into a quiet thread it shows at once; into a busy one it shows as queued until its turn.
      if (this.quiet(thread)) this.show(thread, message)
      else {
        thread.messages.set(message.id, message)
        this.emitQueued(spec.sessionId, message)
      }
      this.enqueueMessage(thread, message)
      if (command.steer && message.state === 'queued') void this.steer(thread, message)
      return
    }
    let input: ThreadInput
    if (command.type === 'thread.answer') {
      this.options.emit(spec.sessionId, {
        at,
        type: 'question.answered',
        teammateId: spec.teammate.id,
        questionId: command.questionId,
        answer: command.answer,
        memberId: command.memberId,
      })
      input = { kind: 'answer', questionId: command.questionId, answer: command.answer }
    } else if (command.type === 'thread.ticket') {
      this.options.emit(spec.sessionId, {
        at,
        type: 'ticket.answered',
        teammateId: spec.teammate.id,
        requestId: command.requestId,
        answer: command.answer,
        memberId: command.memberId,
      })
      input = { kind: 'ticket', requestId: command.requestId, answer: command.answer }
    } else {
      this.options.emit(spec.sessionId, {
        at,
        type: 'approval.resolved',
        teammateId: spec.teammate.id,
        approvalId: command.approvalId,
        approved: command.approved,
        memberId: command.memberId,
        ...(command.reason ? { reason: command.reason } : {}),
      })
      input = {
        kind: 'approval',
        approvalId: command.approvalId,
        approved: command.approved,
        ...(command.reason ? { reason: command.reason } : {}),
      }
    }
    this.enqueue(spec, input)
  }

  /**
   * The API has these threads running here. One with no turn here, and none
   * ended in events still on their way, was lost when this computer stopped or
   * the runner restarted: close it as interrupted, so it does not look busy forever.
   */
  closeLost(
    sessionIds: string[],
    lastUnacknowledged: (sessionId: string) => AgentEvent | undefined,
  ) {
    for (const sessionId of sessionIds) {
      if (!SAFE_ID.test(sessionId) || this.inUse(sessionId)) continue
      const last = lastUnacknowledged(sessionId)
      if (last && OUT_OF_TURN.has(last.type)) continue
      const at = new Date().toISOString()
      this.options.emit(sessionId, {
        at,
        type: 'raw',
        source: 'runner',
        value:
          'The computer stopped during this turn, so it was interrupted. Send a message to continue.',
      })
      this.options.emit(sessionId, { at, type: 'turn.completed', finishReason: 'interrupted' })
    }
  }

  /** A person takes control: the teammate stops now, or after its current turn. */
  takeover(spec: ThreadSpec, memberId: string, interrupt: boolean) {
    const thread = this.thread(spec.sessionId)
    if (thread.takeover) return
    thread.takeover = { memberId, since: Date.now() }
    if (interrupt) thread.controller?.abort()
    // Queued messages do not run while a person has control: say so, rather than drop them silently.
    for (const message of thread.messages.values())
      if (message.state !== 'steering')
        this.cancel(
          spec.sessionId,
          thread,
          message,
          null,
          'A person took over the thread before it ran.',
        )
    // Wait for the current turn to end, then record the change of control.
    thread.queue = thread.queue.then(() => {
      this.options.emit(spec.sessionId, {
        at: new Date().toISOString(),
        type: 'control.changed',
        controller: 'human',
        memberId,
      })
    })
  }

  /** Control returns to the teammate, told what the person did. */
  async handback(
    spec: ThreadSpec,
    memberId: string,
    note: string,
    changedFiles: (since: number) => Promise<string[]>,
  ) {
    const thread = this.thread(spec.sessionId)
    const takeover = thread.takeover
    if (!takeover) return
    // Control returns at once: a ticket answered with the handback comes right behind it.
    thread.takeover = undefined
    this.options.emit(spec.sessionId, {
      at: new Date().toISOString(),
      type: 'control.changed',
      controller: 'teammate',
      memberId,
    })
    const files = await changedFiles(takeover.since).catch(() => [])
    const at = new Date().toISOString()
    if (!note.trim() && files.length === 0) return
    const text = [
      'A person took over this thread and has now handed it back to you.',
      note.trim() && `Their note: ${note.trim()}`,
      files.length > 0
        ? `Files changed while they had control:\n${files.map((f) => `- ${f}`).join('\n')}`
        : 'They changed no files in this directory.',
    ]
      .filter(Boolean)
      .join('\n\n')
    this.options.emit(spec.sessionId, { at, type: 'message.user', text, memberId })
    thread.handoffs = 0
    const upTo = this.note(spec, null, 'A member', text)
    this.enqueue(spec, 'prompt', () => upTo)
  }

  /**
   * The API has these messages as queued here. One this runner does not hold
   * was lost when the computer stopped or the runner restarted: say so, so it
   * does not look queued forever.
   */
  dropLost(queued: { sessionId: string; messageId: string }[]) {
    for (const { sessionId, messageId } of queued) {
      if (!SAFE_ID.test(sessionId) || this.threads.get(sessionId)?.messages.has(messageId)) continue
      this.options.emit(sessionId, {
        at: new Date().toISOString(),
        type: 'message.cancelled',
        messageId,
        memberId: null,
        reason: 'The computer restarted before it ran. Send it again.',
      })
    }
  }

  /**
   * Whether a thread is in use here: a turn queued or running, a person in
   * control, or a harness session not yet parked (one waiting for an approval,
   * say). Its checkouts stay.
   */
  inUse(sessionId: string) {
    const thread = this.threads.get(sessionId)
    if (!thread) return false
    return (
      Boolean(thread.controller || thread.takeover) ||
      [...thread.waiting.values()].some((n) => n > 0) ||
      [...thread.harnesses.values()].some((seat) => seat.harness.active)
    )
  }

  /** A turn is running or queued somewhere. Threads waiting for a person do not count. */
  get busy() {
    return this.pending > 0
  }

  /** Wait until no turn is running or queued, e.g. one that started just before a disconnect. */
  async settle() {
    while (this.pending > 0)
      await Promise.all([...this.threads.values()].map((t) => t.queue.catch(() => undefined)))
  }

  /** Stop every harness session, keeping saved state. Called on shutdown. */
  async parkAll() {
    await Promise.all(
      [...this.threads.values()].flatMap((t) =>
        [...t.harnesses.values()].map((h) => h.harness.park().catch(() => undefined)),
      ),
    )
  }

  /**
   * Queue a turn. 'prompt': the teammate is told what it has not seen yet,
   * worked out when its turn comes, so it sees the replies of those before it.
   * `prepare` runs when the turn is about to start: it gives the log's end to
   * tell up to, or null when the turn no longer happens.
   */
  private enqueue(
    spec: ThreadSpec,
    input: ThreadInput | 'prompt',
    prepare?: () => Promise<number | undefined | null>,
  ) {
    const thread = this.thread(spec.sessionId)
    const seat = this.harness(thread, spec)
    clearTimeout(seat.parkTimer)
    seat.parkTimer = undefined
    clearTimeout(thread.quietTimer)
    this.pending++
    const me = spec.teammate.id
    thread.waiting.set(me, (thread.waiting.get(me) ?? 0) + 1)
    thread.queue = thread.queue.then(async () => {
      let queued = true
      const started = () => {
        if (queued) thread.waiting.set(me, thread.waiting.get(me)! - 1)
        queued = false
      }
      let acquired = false
      const turnId = randomUUID()
      try {
        // Taken over while waiting in the queue: the turn does not happen.
        if (thread.takeover) return
        await this.acquire()
        acquired = true
        const upTo = prepare ? await prepare() : undefined
        started()
        if (upTo === null) return
        const controller = new AbortController()
        thread.controller = controller
        thread.running = { teammateId: me, turnId }
        await this.placeFiles(spec, seat.folder)
        const turn =
          input === 'prompt'
            ? { kind: 'prompt' as const, text: await this.catchUp(spec, upTo) }
            : input
        this.options.emit(spec.sessionId, {
          at: new Date().toISOString(),
          type: 'turn.started',
          teammateId: spec.teammate.id,
          accountId: spec.account.id,
          turnId,
        })
        seat.reply = undefined
        const outcome = await seat.harness.run(turn, spec, controller.signal)
        if (outcome.status === 'waiting' && outcome.error) {
          this.options.emit(spec.sessionId, {
            at: new Date().toISOString(),
            type: 'raw',
            source: 'runner',
            value: outcome.error,
          })
        }
        if (outcome.status === 'idle') {
          // Quiet: park the harness, then put what it has not pushed on GitHub.
          seat.parkTimer = setTimeout(() => {
            seat.parkTimer = undefined
            void seat.harness
              .park()
              .then(() => seat.harness.backup())
              .catch(console.error)
          }, PARK_AFTER_MS)
          thread.lastSpec = spec
          clearTimeout(thread.quietTimer)
          thread.quietTimer = setTimeout(() => this.memorize(spec.sessionId), QUIET_AFTER_MS)
          if (!controller.signal.aborted && !thread.takeover) this.handOn(thread, spec, seat.reply)
        }
        // A person answered: the messages that waited on them go now.
        if (input !== 'prompt') await this.releaseHeld(thread, spec, seat)
      } catch (error) {
        console.error(`thread ${spec.sessionId}: turn failed`, error)
      } finally {
        started()
        if (thread.running?.turnId === turnId) {
          thread.running = undefined
          thread.controller = undefined
        }
        this.pending--
        if (acquired) this.release()
      }
    })
  }

  /** Nothing runs, waits or is queued in the thread: a message can show at once. */
  private quiet(thread: Thread) {
    return (
      !thread.controller &&
      !thread.memorizing &&
      thread.messages.size === 0 &&
      ![...thread.waiting.values()].some((n) => n > 0)
    )
  }

  /** Queue the turns that answer a message: its first teammate's, then the others'. */
  private enqueueMessage(thread: Thread, message: Message) {
    const [first, ...then] = message.specs
    const sessionId = first!.sessionId
    this.enqueue(first!, 'prompt', async () => {
      await message.steering
      if (message.state !== 'queued' && message.state !== 'shown') return null
      // Its teammate waits on a person: the message runs once they answer (releaseHeld).
      if (await this.harness(thread, first!).harness.awaitingPerson()) {
        const shown = message.state === 'shown'
        message.state = 'held'
        thread.messages.set(message.id, message)
        if (!shown) this.emitQueued(sessionId, message)
        else
          this.options.emit(sessionId, {
            at: new Date().toISOString(),
            type: 'raw',
            source: 'runner',
            value: `${first!.teammate.name} reads this message once the pending request is answered.`,
          })
        return null
      }
      if (!message.upTo) return this.show(thread, message)
      message.state = 'shown'
      thread.messages.delete(message.id)
      return message.upTo
    })
    // Each teammate after it is told what was said since its last turn, its predecessors' replies too.
    for (const next of then)
      this.enqueue(next, 'prompt', async () =>
        message.state === 'held' || message.state === 'cancelled' ? null : undefined,
      )
  }

  /**
   * The message goes into the thread where its teammate reads it, and into the
   * log the teammates are told from. Resolves to the log's end just after it.
   */
  private show(thread: Thread, message: Message, steered = false) {
    const spec = message.specs[0]!
    message.state = steered ? 'steered' : 'shown'
    thread.messages.delete(message.id)
    this.options.emit(spec.sessionId, {
      at: new Date().toISOString(),
      type: 'message.user',
      text: message.text,
      memberId: message.memberId,
      messageId: message.id,
      ...(steered ? { steered: true } : {}),
      ...(message.attachments.length
        ? { attachments: message.attachments.map((a) => MessageAttachment.parse(a)) }
        : {}),
    })
    message.upTo = this.note(spec, null, 'A member', this.promptText(message))
    return message.upTo
  }

  /** What the teammate reads: the text, and where the files that came with it are. */
  private promptText(message: Message) {
    return [message.text, attachmentLines(message.attachments)].filter(Boolean).join('\n\n')
  }

  private emitQueued(sessionId: string, message: Message, note?: string) {
    this.options.emit(sessionId, {
      at: new Date().toISOString(),
      type: 'message.queued',
      messageId: message.id,
      text: message.text,
      memberId: message.memberId,
      waitingFor: message.state === 'held' ? 'person' : 'turn',
      ...(note ? { note } : {}),
      ...(message.attachments.length
        ? { attachments: message.attachments.map((a) => MessageAttachment.parse(a)) }
        : {}),
    })
  }

  private cancel(
    sessionId: string,
    thread: Thread,
    message: Message,
    memberId: string | null,
    reason?: string,
  ) {
    message.state = 'cancelled'
    thread.messages.delete(message.id)
    this.options.emit(sessionId, {
      at: new Date().toISOString(),
      type: 'message.cancelled',
      messageId: message.id,
      memberId,
      ...(reason ? { reason } : {}),
    })
  }

  /** A person acts on a queued message: cancel it, change its text, or steer it. */
  private queued(command: Extract<Command, { type: 'thread.queued' }>) {
    const thread = this.threads.get(command.sessionId)
    const message = thread?.messages.get(command.messageId)
    // Already read, or never here (a restart): the thread shows what became of it.
    if (!thread || !message || message.state === 'steering') return
    if (command.action === 'cancel')
      return this.cancel(command.sessionId, thread, message, command.memberId)
    if (command.action === 'edit') {
      if (!command.text?.trim()) return
      message.text = command.text
      return this.emitQueued(command.sessionId, message)
    }
    void this.steer(thread, message)
  }

  /**
   * Give a queued message to its teammate's running turn, which reads it at its
   * next step. When that cannot be done it stays queued, with why.
   */
  private async steer(thread: Thread, message: Message) {
    const spec = message.specs[0]!
    const name = spec.teammate.name
    if (message.state !== 'queued') {
      if (message.state === 'held' && !message.upTo)
        this.emitQueued(
          spec.sessionId,
          message,
          `${name} is waiting for an answer. It runs once someone answers.`,
        )
      return
    }
    if (thread.running?.teammateId !== spec.teammate.id)
      return this.emitQueued(
        spec.sessionId,
        message,
        `${name} is not working on a turn right now, so it runs when its turn comes.`,
      )
    const seat = this.harness(thread, spec)
    message.state = 'steering'
    let done!: () => void
    message.steering = new Promise<void>((resolve) => (done = resolve))
    try {
      // The files that came with it are in the teammate's folder before it reads where they are.
      await this.placeFiles(spec, seat.folder)
      await seat.harness.steer(this.promptText(message))
      const end = await this.show(thread, message, true)
      // It read the message in this turn: its next turn does not tell it again.
      const log = await thread.log
      log.seen[spec.teammate.id] = Math.max(log.seen[spec.teammate.id] ?? 0, end)
      void this.saveLog(spec.sessionId)
    } catch (error) {
      message.state = 'queued'
      console.warn(`thread ${spec.sessionId}: could not steer: ${String(error)}`)
      this.emitQueued(
        spec.sessionId,
        message,
        `${name} could not take it during this turn, so it runs after it.`,
      )
    } finally {
      message.steering = undefined
      done()
    }
  }

  /** The teammate no longer waits on a person: the messages held for that are queued again. */
  private async releaseHeld(thread: Thread, spec: ThreadSpec, seat: Seat) {
    const held = [...thread.messages.values()].filter(
      (m) => m.state === 'held' && m.specs[0]!.teammate.id === spec.teammate.id,
    )
    if (held.length === 0 || thread.takeover || (await seat.harness.awaitingPerson())) return
    for (const message of held) {
      message.state = 'queued'
      // One already in the thread runs without showing as queued again.
      if (message.upTo) message.state = 'shown'
      else this.emitQueued(spec.sessionId, message)
      this.enqueueMessage(thread, message)
    }
  }

  /** Put the thread's files in the teammate's folder; say in the thread which could not be. */
  private async placeFiles(spec: ThreadSpec, folder: Folder) {
    const failed = await this.options.attachments
      .deliver(spec.attachments, folder)
      .catch((error: unknown) => [String(error)])
    if (failed.length === 0) return
    this.options.emit(spec.sessionId, {
      at: new Date().toISOString(),
      type: 'raw',
      source: 'runner',
      value: `Could not put some attached files in ${spec.teammate.name}'s folder:\n${failed.map((f) => `- ${f}`).join('\n')}`,
    })
  }

  /**
   * A reply that mentions other teammates of the thread hands it to them, unless
   * they already answer after it. Stops after MAX_HANDOFFS without a member.
   */
  private handOn(thread: Thread, spec: ThreadSpec, reply: string | undefined) {
    if (!reply) return
    const me = spec.teammate.id
    const next = mentionedTeammates(reply, spec).filter(
      (id) => id !== me && !thread.waiting.get(id),
    )
    if (next.length === 0) return
    if (thread.handoffs >= MAX_HANDOFFS) {
      this.options.emit(spec.sessionId, {
        at: new Date().toISOString(),
        type: 'raw',
        source: 'runner',
        value: `Teammates answered one another ${MAX_HANDOFFS} times in a row. Send a message to let them go on.`,
      })
      return
    }
    thread.handoffs++
    this.options.handoff(spec.sessionId, me, next.slice(0, 5))
  }

  /**
   * The thread went quiet: a short harness run takes its summary and what it
   * taught, for the memory files. Only what was said since the last time.
   */
  private memorize(sessionId: string) {
    const thread = this.threads.get(sessionId)
    const spec = thread?.lastSpec
    if (!thread || !spec || thread.takeover || [...thread.waiting.values()].some((n) => n > 0))
      return
    this.pending++
    thread.memorizing = true
    thread.queue = thread.queue.then(async () => {
      try {
        const log = await thread.log
        const end = log.start + log.entries.length
        const from = Math.max(log.memorized ?? 0, log.start)
        const fresh = log.entries.slice(from - log.start)
        // Nothing a teammate said since last time: nothing to remember.
        if (!fresh.some((e) => e.by)) return
        await this.acquire()
        try {
          const speakers = spec.teammates.filter((t) => fresh.some((e) => e.by === t.id))
          const text = await runOnce({
            spec,
            ...this.memoryWorkDir(spec),
            prompt: memoryPrompt({
              spec,
              entries: fresh,
              summary: log.summary,
              memory: this.options.context.memoryFor,
              speakers,
            }),
            signal: AbortSignal.timeout(MEMORY_RUN_MS),
          })
          const update = parseMemory(text, spec, speakers)
          if (!update) return console.warn(`thread ${sessionId}: memory run gave no usable answer`)
          this.options.memoryUpdate({ type: 'memory.update', sessionId, ...update })
          log.memorized = end
          log.summary = update.summary
          await this.saveLog(sessionId)
        } finally {
          this.release()
        }
      } catch (error) {
        console.warn(`thread ${sessionId}: memory run failed: ${String(error)}`)
      } finally {
        thread.memorizing = false
        this.pending--
      }
    })
  }

  /** Where a memory run works: an empty directory of the teammate's, never the thread's. */
  private memoryWorkDir(spec: ThreadSpec) {
    const user = CLOUD ? teammateUser(spec.teammate.id) : undefined
    return user
      ? { workDir: `${teammateHome(user)}/.memory-runs/${spec.sessionId}`, runAs: user }
      : { workDir: join(paths.state, 'memory-runs', spec.sessionId) }
  }

  /**
   * The prompt for a teammate's turn: what was said since its last one, up to
   * `upTo` when given. A lone member message to a teammate that already knows
   * the thread goes as is, so a thread with one teammate reads as before.
   */
  private async catchUp(spec: ThreadSpec, upTo?: number) {
    const thread = this.thread(spec.sessionId)
    const log = await thread.log
    const me = spec.teammate.id
    const known = me in log.seen
    const end = Math.min(upTo ?? Infinity, log.start + log.entries.length)
    const from = Math.max(log.seen[me] ?? 0, log.start)
    const unseen = log.entries
      .slice(Math.max(0, from - log.start), Math.max(0, end - log.start))
      .filter((e) => e.by !== me)
    log.seen[me] = Math.max(log.seen[me] ?? 0, end)
    void this.saveLog(spec.sessionId)
    const others = spec.teammates.filter((t) => t.id !== me).map((t) => t.name)
    const last = unseen.at(-1)
    if ((known || others.length === 0) && unseen.length === 1 && last?.by === null) return last.text

    let budget = CATCH_UP_CHARS
    const lines: string[] = []
    for (const e of [...unseen].reverse()) {
      const line = `${e.name}${e.by ? ' (teammate)' : ''}: ${e.text}`
      if (lines.length > 0 && line.length > budget) break
      lines.unshift(line.length > budget ? `${line.slice(0, budget)}…` : line)
      budget -= line.length
    }
    return [
      others.length > 0 &&
        `You are ${spec.teammate.name}, one of the AI teammates in this thread, with ${others.join(', ')}. Each of you works in your own session and directory; here is what was said since your last turn. ` +
          `To have a teammate answer after you, mention them as @Name in your reply; mention one only when you need them to act now.`,
      lines.length > 0 && lines.join('\n\n'),
      `Reply to the latest message as ${spec.teammate.name}.`,
    ]
      .filter(Boolean)
      .join('\n\n')
  }

  /**
   * Remember what was said in the thread, for the teammates that did not see
   * it. Resolves to the log's end just after it.
   */
  private note(spec: ThreadSpec, by: string | null, name: string, text: string) {
    const thread = this.thread(spec.sessionId)
    const log = thread.log.then((log) => {
      log.entries.push({ by, name, text })
      const drop = log.entries.length - LOG_ENTRIES
      if (drop > 0) {
        log.entries.splice(0, drop)
        log.start += drop
      }
      // What the speaker has seen moves only when it is told (catchUp): a message
      // that came in while it was replying is still unseen. Its own lines are skipped there.
      if (by && !(by in log.seen)) log.seen[by] = log.start + log.entries.length
      return log
    })
    thread.log = log
    void this.saveLog(spec.sessionId)
    return log.then((l) => l.start + l.entries.length)
  }

  private logFile = (sessionId: string) => join(paths.state, `${sessionId}.team.json`)

  private async saveLog(sessionId: string) {
    const log = await this.thread(sessionId).log
    await mkdir(paths.state, { recursive: true, mode: 0o700 })
    await writeFile(this.logFile(sessionId), JSON.stringify(log), { mode: 0o600 }).catch((error) =>
      console.warn(`could not save thread log: ${String(error)}`),
    )
  }

  private thread(sessionId: string): Thread {
    let thread = this.threads.get(sessionId)
    if (!thread) {
      const empty: Log = { start: 0, entries: [], seen: {} }
      thread = {
        harnesses: new Map(),
        queue: Promise.resolve(),
        controller: undefined,
        messages: new Map(),
        memorizing: false,
        waiting: new Map(),
        handoffs: 0,
        log: readFile(this.logFile(sessionId), 'utf8').then(
          (text) => JSON.parse(text) as Log,
          () => empty,
        ),
      }
      this.threads.set(sessionId, thread)
    }
    return thread
  }

  private harness(thread: Thread, spec: ThreadSpec): Seat {
    const teammateId = spec.teammate.id
    let seat = thread.harnesses.get(teammateId)
    if (!seat) {
      // On a cloud computer each teammate runs as its own Linux user, in its own home.
      const user = CLOUD ? teammateUser(teammateId) : undefined
      const folder: Folder = {
        key: `${spec.sessionId}-${teammateId}`,
        workDir: user
          ? `${teammateHome(user)}/threads/${spec.sessionId}`
          : paths.threadDir(teammateId, spec.sessionId),
        ...(user ? { runAs: user } : {}),
      }
      const harness = new HarnessThread(
        spec,
        folder.workDir,
        paths.state,
        (event) => {
          // In a thread with several teammates, each event says whose it is.
          this.options.emit(spec.sessionId, { ...event, teammateId })
          if (event.type === 'message.done' && event.text.trim()) {
            this.note(spec, teammateId, spec.teammate.name, event.text)
            seat!.reply = event.text
          }
        },
        // Files a call brings (an email's attachment) are in the folder before the teammate reads the result.
        async (call) => {
          const { output, attachments } = await this.options.callConnector(
            spec.sessionId,
            teammateId,
            call,
          )
          const failed = await this.options.attachments.deliver(attachments, folder)
          if (failed.length > 0)
            throw new Error(`Could not put the file here: ${failed.join('; ')}`)
          return output
        },
        (request) => this.options.requestCredential(spec.sessionId, teammateId, request),
        {
          ...this.options.context,
          callLibrary: (call) => this.options.callLibrary(spec.sessionId, teammateId, call),
          callTask: (call) => this.options.callTask(spec.sessionId, teammateId, call),
          callSchedule: (call) => this.options.callSchedule(spec.sessionId, teammateId, call),
          preview: this.options.previews.forSeat({
            sessionId: spec.sessionId,
            teammateId,
            workDir: folder.workDir,
            ...(user ? { runAs: user } : {}),
          }),
        },
        user,
      )
      seat = { harness, folder, parkTimer: undefined }
      thread.harnesses.set(teammateId, seat)
    }
    return seat
  }

  private async acquire() {
    if (this.running < this.options.concurrency) {
      this.running++
      return
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
  }

  private release() {
    const next = this.waiters.shift()
    if (next) next()
    else this.running--
  }
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The teammates of the thread a reply mentions, in order: as a mention chip,
 * or as plain @Name (teammates write that). Longer names first, so "@Cody 2"
 * is not read as "@Cody".
 */
export function mentionedTeammates(text: string, spec: ThreadSpec) {
  const found: { id: string; at: number }[] = []
  for (const id of mentionedIds(text, 'teammate'))
    if (spec.teammates.some((t) => t.id === id)) found.push({ id, at: text.indexOf(id) })
  const names = [...spec.teammates].sort((a, b) => b.name.length - a.name.length)
  let rest = text
  for (const t of names) {
    const pattern = new RegExp(`(^|[^\\w@])@${escape(t.name)}(?![\\w])`, 'gi')
    for (const m of rest.matchAll(pattern)) found.push({ id: t.id, at: m.index })
    rest = rest.replace(pattern, (whole) => ' '.repeat(whole.length))
  }
  return [...new Set(found.sort((a, b) => a.at - b.at).map((f) => f.id))]
}
