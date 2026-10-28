// Runs threads on this computer: one harness session per teammate in a thread,
// turns of a thread in order (several teammates answer one after another), and
// at most `concurrency` turns at once across threads. A member's message that
// comes in while the thread is busy waits in its queue, shown as queued, until
// its turn starts; meanwhile it can be steered into the running turn, and cancelled or
// edited when a person wrote it.
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, statfs, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  ASIDE_TOOLS,
  attachmentLines,
  bareToolName,
  commandPrompt,
  handbackMessage,
  mayChangeQueued,
  memoryFilePath,
  mentionedIds,
  MessageAttachment,
  THREAD_NOTE_SOURCE,
  TURN_WAITING_SOURCE,
  turnAnswer,
  visibleChars,
  type AgentEvent,
  type BackgroundWork,
  type ApiToRunner,
  type RunnerToApi,
  type ThreadAttachmentRef,
  type ReplyTo,
  type ThreadPrompt,
  type ThreadSpec,
  type TurnEntry,
  type TurnWaiting,
} from '@brigade/contracts'
import type { Attachments, Folder } from './attachments.js'
import type { Folders } from './folders.js'
import type { HandedOver } from './hand-over.js'
import type { Previews } from './previews.js'
import { memoryRun } from './memory.js'
import { memoryNews, threadMemory } from './memory-layers.js'
import { tidyRun, type TidyFile } from './memory-tidy.js'
import { MARKS_RULE, missedLines, type Indexed, type LogEntry } from './said.js'
import { parseTitle, TITLE_MODEL, titlePrompt } from './title.js'
import { keepReplyImages, type StoreImage } from './reply-images.js'
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
const CATCH_UP_CHARS = 100_000
const LOG_ENTRIES = 200
/** Teammates handing the thread to one another stop after this many handoffs without a member. */
const MAX_HANDOFFS = 40
/** A thread this long without a turn has gone quiet: its memory is taken then. */
const QUIET_AFTER_MS = Number(process.env.BRIGADE_QUIET_MS) || PARK_AFTER_MS
/** Longest a memory run may take. */
const MEMORY_RUN_MS = 4 * 60_000
/** Longest a tidy run may take: it reads and lays out a whole memory file, beside the thread. */
const TIDY_RUN_MS = 15 * 60_000
/** A file whose tidy run failed is not tried again on this computer before this. */
const TIDY_RETRY_MS = 60 * 60_000
/** Nor one this computer just tidied, as memory-tidy.ts's own gap. */
const TIDY_RESEND_MS = 6 * 60 * 60_000
/** When the runner stops, how long it waits for the turns it froze to come back out. */
const STOP_GRACE_MS = 10_000
/** Longest a title run may take: past that, the thread keeps its first line. */
const TITLE_RUN_MS = 60_000
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

/**
 * Errors that pass (a full disk, the network, Claude's API down or overloaded): a turn that
 * failed on one is tried again on its own, after RETRY_AFTER_MS. Out of usage is not one
 * of them: that turn moves to another account, or pauses (HarnessThread.run).
 */
const PASSING_ERROR =
  /ENOSPC|no space left|EAI_AGAIN|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|fetch failed|network error|overloaded|internal server error|api_error|service unavailable|bad gateway|gateway time-?out|\b(500|502|503|504|529)\b/i
/** A full disk: tried again only once this much is free on it. */
const DISK_ERROR = /ENOSPC|no space left/i
const FREE_BYTES = 1024 ** 3
/** How long before each try of a turn that failed on a passing error; then a person tries again. */
const RETRY_AFTER_MS = Number(process.env.BRIGADE_RETRY_MS)
  ? Array<number>(3).fill(Number(process.env.BRIGADE_RETRY_MS))
  : [60_000, 5 * 60_000, 15 * 60_000]
/** What a teammate is told when its turn is tried again after it failed. */
const retried = (error: string) =>
  `Your last turn in this thread stopped on an error: ${error.slice(0, 2_000)}\n\n` +
  'Before you redo anything, check what is already done (files, commands you ran, messages you sent), then carry on where you left off.'

/** A queued message's note while a person has control of its thread. */
const HELD_FOR_HANDBACK = 'A person has control of this thread. It runs once they hand it back.'

/** Events that end a turn: one still on its way to the API says the turn was over. */
const TURN_ENDED = new Set<AgentEvent['type']>(['turn.completed', 'error'])

/**
 * A thread the API had in progress here when this runner connected. running:
 * the API had it running, else waiting on a person. ended: events on their way
 * to the API say its turn was over.
 */
type Lost = { kind: 'lost'; running: boolean; ended: boolean }

/** A failed turn tried again: the teammate is told the error, and what was said since. */
type Retry = { kind: 'retry'; error: string }

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
      | 'thread.retry'
  }
>

type Seat = {
  harness: HarnessThread
  folder: Folder
  parkTimer: NodeJS.Timeout | undefined
  /** The running turn's messages and steps: its answer is what hands it on (handOn). */
  turn: (TurnEntry & { text?: string })[]
  /** The running turn's spec: the teammates its answer may hand on to. */
  spec?: ThreadSpec
  /** The running turn only waits on work started in the background: a new message goes straight in. */
  waiting: boolean
  /** Memory lines learned since the session started that it was told (memoryNews). */
  told: Set<string>
  /** What the running turn runs in the background now: shells, Monitors, agents. */
  background: BackgroundWork[]
}

/** The bridge's word on whether the turn only waits on background work, from a harness event. */
function backgroundWait(event: AgentEvent): boolean | undefined {
  if (event.type !== 'raw' || event.source !== 'harness') return
  const value = event.value as { type?: unknown; subtype?: unknown; waiting?: unknown } | null
  if (value?.type === 'system' && value.subtype === 'brigade_waiting') return value.waiting === true
}

/** Claude Code's task types that are agents at work, and those that are commands (a shell, a Monitor). */
const AGENT_TASKS = new Set(['local_agent', 'remote_agent', 'local_workflow'])
const COMMAND_TASKS = new Set(['local_bash', 'monitor_mcp'])

/** What runs in the background after one of Claude Code's task messages, from a harness event. */
export function backgroundTasks(event: AgentEvent): BackgroundWork[] | undefined {
  if (event.type !== 'raw' || event.source !== 'harness') return
  const value = event.value as {
    type?: unknown
    subtype?: unknown
    tasks?: { task_type?: unknown; description?: unknown; ambient?: unknown }[]
  } | null
  if (value?.type !== 'system' || value.subtype !== 'background_tasks_changed') return
  if (!Array.isArray(value.tasks)) return
  return value.tasks.flatMap((task) => {
    const type = String(task.task_type)
    if (task.ambient || !(AGENT_TASKS.has(type) || COMMAND_TASKS.has(type))) return []
    return [
      {
        kind: AGENT_TASKS.has(type) ? ('agent' as const) : ('command' as const),
        description: String(task.description ?? '').slice(0, 500),
      },
    ]
  })
}

/** A turn's answer as the thread shows it (turnAnswer), joined. */
const answerOf = (turn: Seat['turn']) =>
  turnAnswer(turn)
    .messages.map((at) => turn[at]!.text)
    .join('\n\n')

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
  /** The earlier message it replies to. */
  replyTo?: ReplyTo
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
  entries: LogEntry[]
  /** Per teammate: the index up to which it has been told. */
  seen: Record<string, number>
  /** The first thing a person said, kept once the entries are dropped past it. */
  ask?: Indexed
  /** The index up to which memory was taken, and the thread's summary then. */
  memorized?: number
  summary?: string
}

/** The first thing a person said in the thread, when the log still knows it. */
function firstAsk(log: Log): Indexed | undefined {
  if (log.ask || log.start > 0) return log.ask
  const i = log.entries.findIndex((e) => e.by === null && !e.note)
  return i < 0 ? undefined : { ...log.entries[i]!, at: i }
}

/** Add to the log, dropping its oldest entries past LOG_ENTRIES but keeping the first ask. */
function push(log: Log, entry: LogEntry) {
  log.entries.push(entry)
  const drop = log.entries.length - LOG_ENTRIES
  if (drop > 0) {
    log.ask = firstAsk(log)
    log.entries.splice(0, drop)
    log.start += drop
  }
}

type Thread = {
  /** One harness session per teammate, by teammate id, and where it works. */
  harnesses: Map<string, Seat>
  queue: Promise<void>
  controller: AbortController | undefined
  /** The turn running now, and whose. */
  running?: { teammateId: string; turnId: string }
  /** Whose turn waits for a free slot on this computer, all its turns being taken. */
  slotWait?: TurnWaiting
  /** Messages not yet read: queued, held or being steered, by id. */
  messages: Map<string, Message>
  /** A memory run is queued or running: a new message waits for it. */
  memorizing: boolean
  /** Set while a person holds control: no teammate acts in the thread. */
  takeover?: { memberId: string; since: number; teammateId: string }
  log: Promise<Log>
  /** Turns queued and not yet started, by teammate id. */
  waiting: Map<string, number>
  /** Handoffs since a member last wrote. */
  handoffs: number
  /** Fires when the thread goes quiet, to take its memory. */
  quietTimer?: NodeJS.Timeout
  /** The latest turn's spec: the account and teammates a memory run uses. */
  lastSpec?: ThreadSpec
  /**
   * The latest turn failed: whose, on what error, and how many times it was tried again on
   * its own since a person last asked; with the timer of the next try (failed).
   */
  failed?: { spec: ThreadSpec; error: string; tries: number; timer?: NodeJS.Timeout }
}

export class Threads {
  private threads = new Map<string, Thread>()
  private running = 0
  /** Turns queued or running, across threads. */
  private pending = 0
  /** Memory files a tidy run is laying out now, by path; when one last failed, and when one was last sent. */
  private readonly tidying = new Set<string>()
  private readonly tidyFailed = new Map<string, number>()
  private readonly tidySent = new Map<string, number>()
  private waiters: Array<() => void> = []
  /** The runner is stopping (stop): nothing new starts. */
  private stopping = false
  /** Aborts the memory runs under way when the runner stops. */
  private readonly stopped = new AbortController()

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
      /** Put an image a reply shows in its thread's bucket folder (reply-images.ts). */
      storeImage: StoreImage
      /** Thread folders archived to free disk, or moved here: put back before a turn. */
      folders: Pick<Folders, 'ready' | 'takeNote' | 'touch' | 'arrive' | 'release'>
      /**
       * On a computer that replaces another: resolves once what the old one had is put back
       * (computer-backups.ts), before any turn; and what a teammate is told of what did not come back.
       */
      restored?: {
        ready: () => Promise<void>
        takeNote: (teammateId: string) => Promise<string | undefined>
      }
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
      /** A memory file laid out again by a tidy run. */
      memoryTidy: (tidy: Extract<RunnerToApi, { type: 'memory.tidy' }>) => void
      /** A title for a new thread. */
      title: (update: Extract<RunnerToApi, { type: 'thread.title' }>) => void
    },
  ) {}

  handle(command: Command) {
    if (command.type === 'thread.interrupt') {
      const thread = this.threads.get(command.sessionId)
      // An interrupt meant for a turn that already ended does not stop the next one.
      if (thread && (!command.turnId || thread.running?.turnId === command.turnId))
        thread.controller?.abort()
      // Stopped, a failed turn is not tried again on its own either.
      if (thread) this.settleFailure(thread)
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
    // Someone wrote, or a person asked: what goes on now is theirs, not a try planned before.
    if (command.type === 'thread.prompt') this.settleFailure(this.thread(spec.sessionId))
    if (command.type === 'thread.retry') return this.retry(spec, command.error)
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
        ...(command.replyTo ? { replyTo: command.replyTo } : {}),
        state: 'queued',
      }
      // Into a quiet thread it shows at once; into a busy one it shows as queued until its turn.
      if (this.quiet(thread)) this.show(thread, message)
      else {
        thread.messages.set(message.id, message)
        this.emitQueued(spec.sessionId, message)
      }
      // A turn answered already only waits on Claude Code's guess, which no longer matters.
      if (thread.running) void thread.harnesses.get(thread.running.teammateId)?.harness.stopDrain()
      this.enqueueMessage(thread, message)
      // A turn that only waits on its background work takes it at once, as if steered,
      // unless one is already in it: then it waits its turn (steerQueued).
      if (message.state === 'queued') {
        if (command.steer) void this.steer(thread, message)
        else if (this.waiting(thread, message)) this.steerQueued(thread, spec.teammate.id)
      }
      if (command.nameThread !== undefined) void this.name(spec, command.text, command.nameThread)
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
   * The API has these threads in progress here (running, or waiting on a
   * person), each with the teammate whose turn it is. One this runner holds no
   * turn of may have lost it when the computer stopped or the runner restarted:
   * whether it did, and what then, is worked out in its place in the queue (see
   * pickUp), before any message queued after it.
   */
  resumeLost(
    specs: ThreadSpec[],
    running: string[],
    lastUnacknowledged: (sessionId: string) => AgentEvent | undefined,
  ) {
    for (const spec of specs) {
      if (!SAFE_ID.test(spec.sessionId) || !SAFE_ID.test(spec.teammate.id)) continue
      if (this.inUse(spec.sessionId)) continue
      const last = lastUnacknowledged(spec.sessionId)
      this.enqueue(spec, {
        kind: 'lost',
        running: running.includes(spec.sessionId),
        ended: !!last && TURN_ENDED.has(last.type),
      })
    }
  }

  /**
   * What becomes of a thread the API had in progress here. A turn cut off here
   * goes on, told what was said since. A message read but not yet answered is
   * answered. One waiting on a person stays so. A running one with nothing to
   * go on is closed as interrupted. Null: no turn now.
   */
  private async pickUp(spec: ThreadSpec, seat: Seat, lost: Lost): Promise<ThreadInput | null> {
    if (lost.ended) return null
    if (await seat.harness.cutOff())
      return { kind: 'resume', text: await this.catchUp(spec, undefined, true) }
    if (!lost.running) return null
    const unseen = await this.catchUp(spec, undefined, true)
    if (unseen) return { kind: 'prompt', text: unseen }
    this.closeInterrupted(spec.sessionId)
    return null
  }

  /**
   * The API has these messages as queued here. One this runner does not hold,
   * and that was neither read nor cancelled in events still on their way, was
   * lost when the computer stopped or the runner restarted: it is queued again.
   */
  requeueLost(prompts: ThreadPrompt[], unacknowledged: (sessionId: string) => AgentEvent[]) {
    for (const prompt of prompts) {
      const { sessionId } = prompt.thread
      if (!prompt.messageId || this.held(sessionId, prompt.messageId, unacknowledged)) continue
      try {
        this.handle(prompt)
      } catch (error) {
        console.warn(`thread ${sessionId}: could not queue a message again: ${String(error)}`)
      }
    }
  }

  /** The runner holds this message, or what became of it is still on its way to the API. */
  private held(
    sessionId: string,
    messageId: string,
    unacknowledged: (sessionId: string) => AgentEvent[],
  ) {
    if (!SAFE_ID.test(sessionId)) return true
    if (this.threads.get(sessionId)?.messages.has(messageId)) return true
    return unacknowledged(sessionId).some(
      (e) =>
        (e.type === 'message.user' || e.type === 'message.cancelled') && e.messageId === messageId,
    )
  }

  /**
   * The API has these threads running here and could not say whose turn it
   * was. One with no turn here, and none ended in events still on their way,
   * was lost when this computer stopped or the runner restarted: close it as
   * interrupted, so it does not look busy forever.
   */
  closeLost(
    sessionIds: string[],
    lastUnacknowledged: (sessionId: string) => AgentEvent | undefined,
  ) {
    for (const sessionId of sessionIds) {
      if (!SAFE_ID.test(sessionId) || this.inUse(sessionId)) continue
      const last = lastUnacknowledged(sessionId)
      if (last && OUT_OF_TURN.has(last.type)) continue
      this.closeInterrupted(sessionId)
    }
  }

  private closeInterrupted(sessionId: string) {
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

  /** The teammates of the threads a person has control of now, by id. */
  controlledTeammates() {
    return new Set([...this.threads.values()].flatMap((t) => t.takeover?.teammateId ?? []))
  }

  /** A person takes control: the teammate stops now, or after its current turn. */
  takeover(spec: ThreadSpec, memberId: string, interrupt: boolean) {
    const thread = this.thread(spec.sessionId)
    if (thread.takeover) return
    thread.takeover = { memberId, since: Date.now(), teammateId: spec.teammate.id }
    this.settleFailure(thread)
    void this.options.previews.threadBusy(spec.sessionId)
    if (interrupt) thread.controller?.abort()
    // Queued messages wait while a person has control, as wake-ups do: they run once handed back.
    for (const message of thread.messages.values())
      if (message.state === 'queued') {
        message.state = 'held'
        this.emitQueued(spec.sessionId, message, HELD_FOR_HANDBACK)
      }
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
    // In the queue at once, ahead of a ticket answered with the hand back: it runs first,
    // while its teammate still waits on that person, and then starts no turn, which would
    // only fail. The teammate reads the message with its next turn.
    this.enqueue(spec, 'prompt', async () => {
      const waiting = await this.harness(thread, spec).harness.awaitingPerson()
      // The messages held while the person had control queue behind this turn, each teammate's
      // once it waits on nobody (releaseHeld). Here, every turn queued before is over.
      await this.releaseAllHeld(thread)
      const files = await changedFiles(takeover.since).catch(() => [])
      if (!note.trim() && files.length === 0) return null
      const text = handbackMessage({ note, files })
      const at = new Date().toISOString()
      this.options.emit(spec.sessionId, { at, type: 'message.user', text, memberId })
      thread.handoffs = 0
      const upTo = await this.note(spec, null, 'A member', text)
      return waiting ? null : upTo
    })
  }

  /**
   * The API has these messages as queued here. One this runner does not hold
   * was lost when the computer stopped or the runner restarted: say so, so it
   * does not look queued forever.
   */
  dropLost(
    queued: { sessionId: string; messageId: string }[],
    unacknowledged: (sessionId: string) => AgentEvent[],
  ) {
    for (const { sessionId, messageId } of queued) {
      if (this.held(sessionId, messageId, unacknowledged)) continue
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
  /** What a teammate's turn in the thread runs in the background now. */
  background(sessionId: string, teammateId: string): BackgroundWork[] {
    return this.threads.get(sessionId)?.harnesses.get(teammateId)?.background ?? []
  }

  inUse(sessionId: string) {
    const thread = this.threads.get(sessionId)
    if (!thread) return false
    return (
      Boolean(thread.controller || thread.takeover) ||
      [...thread.waiting.values()].some((n) => n > 0) ||
      [...thread.harnesses.values()].some((seat) => seat.harness.active)
    )
  }

  /**
   * The thread came here from another computer (ThreadSpec.moved): what this
   * runner kept of it from before it left is out of date. Each teammate's
   * session and folder are taken in at its next turn (HarnessThread, Folders).
   */
  forget(sessionId: string) {
    const thread = this.threads.get(sessionId)
    if (thread && this.inUse(sessionId)) return
    if (thread) {
      clearTimeout(thread.quietTimer)
      this.settleFailure(thread)
      for (const seat of thread.harnesses.values()) clearTimeout(seat.parkTimer)
      this.threads.delete(sessionId)
    }
    void rm(this.logFile(sessionId), { force: true }).catch(() => undefined)
  }

  /**
   * The thread moves to another computer, once its turns here are over (the
   * API waits for them): its teammates' sessions stop, their folders go to the
   * bucket for the other computer, and this runner forgets it. Throws when a
   * folder could not be handed over; the others still are.
   */
  async handOver(sessionId: string, teammateIds: string[]) {
    if (!SAFE_ID.test(sessionId) || teammateIds.some((id) => !SAFE_ID.test(id)))
      throw new Error('Invalid thread id')
    const thread = this.threads.get(sessionId)
    if (thread) {
      if (thread.takeover) throw new Error('A person has control of this thread')
      await thread.queue.catch(() => undefined)
      clearTimeout(thread.quietTimer)
      this.settleFailure(thread)
      for (const seat of thread.harnesses.values()) {
        clearTimeout(seat.parkTimer)
        await seat.harness.park().catch(() => undefined)
      }
      this.threads.delete(sessionId)
    }
    await this.options.previews
      .stop(sessionId, 'The thread moved to another computer.')
      .catch(() => undefined)
    const failed: string[] = []
    for (const teammateId of teammateIds)
      await this.options.folders.release({ sessionId, teammateId }).catch((error: unknown) => {
        failed.push(String(error))
      })
    // Its saved sessions and log are the other computer's to make now.
    await Promise.all(
      [
        this.logFile(sessionId),
        join(paths.state, `${sessionId}.json`),
        ...teammateIds.map((id) => join(paths.state, `${sessionId}-${id}.json`)),
      ].map((file) => rm(file, { force: true }).catch(() => undefined)),
    )
    if (failed.length > 0) throw new Error(failed.join('; '))
  }

  /** A turn is running or queued somewhere. Threads waiting for a person do not count. */
  get busy() {
    return this.pending > 0
  }

  /**
   * The runner stops, to update or shut down: no turn or memory run starts any
   * more, and every harness session is parked with its state. A running turn is
   * frozen and goes on after the restart (pickUp): none is waited for, since one
   * may run for hours and every thread here would wait with it.
   */
  async stop() {
    this.stopping = true
    this.stopped.abort()
    await this.parkAll()
    // Frozen, a running turn comes back out at once, and the turns queued behind it no longer
    // start; a session one of them started meanwhile is parked too. A turn still running past
    // this is cut off by the restart, and goes on from its conversation (recover).
    await Promise.race([this.settle(), sleep(STOP_GRACE_MS)])
    await this.parkAll()
  }

  /**
   * The runner restarts into an update: as stop(), but the turns running now go on in their
   * harnesses, which the next runner takes up where they are (HarnessThread.handOver).
   * Resolves to those harnesses' process groups, for the next runner to keep (hand-over.ts).
   */
  async handOverTurns(): Promise<HandedOver[]> {
    this.stopping = true
    this.stopped.abort()
    const handed = await Promise.all(
      [...this.threads.values()].flatMap((thread) =>
        [...thread.harnesses].map(([teammateId, seat]) =>
          thread.running?.teammateId === teammateId
            ? seat.harness.handOver().catch(() => [])
            : seat.harness.park().then(
                () => [],
                () => [],
              ),
        ),
      ),
    )
    await Promise.race([this.settle(), sleep(STOP_GRACE_MS)])
    await this.parkAll()
    return handed.flat()
  }

  /** Wait until no turn is running or queued. */
  private async settle() {
    while (this.pending > 0)
      await Promise.all([...this.threads.values()].map((t) => t.queue.catch(() => undefined)))
  }

  /** Stop every harness session, keeping saved state. */
  private async parkAll() {
    await Promise.all(
      [...this.threads.values()].flatMap((t) =>
        [...t.harnesses.values()].map((h) => h.harness.park().catch(() => undefined)),
      ),
    )
  }

  /**
   * Queue a turn. 'prompt': the teammate is told what it has not seen yet,
   * worked out when its turn comes, so it sees the replies of those before it.
   * Lost: a thread the API had in progress when this runner connected (see pickUp).
   * `prepare` runs when the turn is about to start: it gives the log's end to
   * tell up to, or null when the turn no longer happens.
   */
  private enqueue(
    spec: ThreadSpec,
    input: ThreadInput | 'prompt' | Lost | Retry,
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
        // Every slot taken: the thread shows its teammate waiting, with how many turns run.
        await this.acquire((running) => {
          thread.slotWait = { teammateId: me, running }
          this.options.emit(spec.sessionId, {
            at: new Date().toISOString(),
            type: 'raw',
            source: TURN_WAITING_SOURCE,
            value: thread.slotWait,
          })
        })
        thread.slotWait = undefined
        acquired = true
        // The runner is stopping: the API still has the turn, and gives it to the next runner.
        if (this.stopping) return
        const upTo = prepare ? await prepare() : undefined
        started()
        if (upTo === null) return
        // Set when the turn before it ended, after this one was queued: it would park this one.
        clearTimeout(seat.parkTimer)
        seat.parkTimer = undefined
        const controller = new AbortController()
        thread.controller = controller
        thread.running = { teammateId: me, turnId }
        seat.waiting = false
        const name = { sessionId: spec.sessionId, teammateId: me }
        try {
          await this.options.restored?.ready()
          if (spec.moved) await this.options.folders.arrive(name, spec.moved)
          await this.options.folders.ready(name)
          // A frozen preview, and the containers it paused: the turn may use them.
          await this.options.previews.threadBusy(spec.sessionId)
        } catch (error) {
          this.options.emit(spec.sessionId, {
            at: new Date().toISOString(),
            type: 'raw',
            source: 'runner',
            value: `Could not put ${spec.teammate.name}'s files for this thread back on this computer, so its turn did not start (${String(error)}). Send a message to try again.`,
          })
          return
        }
        await this.placeFiles(spec, seat.folder)
        const turn =
          input === 'prompt'
            ? {
                kind: 'prompt' as const,
                text: await (async () => {
                  const note = await this.options.folders.takeNote(name, spec.git)
                  const lost = await this.options.restored?.takeNote(me)
                  const told = await this.catchUp(spec, upTo)
                  return [note, lost, this.memoryNews(spec, seat), told]
                    .filter(Boolean)
                    .join('\n\n')
                })(),
              }
            : input.kind === 'lost'
              ? await this.pickUp(spec, seat, input)
              : input.kind === 'retry'
                ? {
                    kind: 'prompt' as const,
                    text: [retried(input.error), await this.catchUp(spec, undefined, true)]
                      .filter(Boolean)
                      .join('\n\n'),
                  }
                : input
        if (!turn || this.stopping) return
        this.options.emit(spec.sessionId, {
          at: new Date().toISOString(),
          type: 'turn.started',
          teammateId: spec.teammate.id,
          accountId: spec.account.id,
          turnId,
        })
        seat.turn = []
        seat.spec = spec
        const outcome = await seat.harness.run(turn, spec, controller.signal)
        if (outcome.status === 'failed' && !controller.signal.aborted)
          this.failed(thread, spec, outcome.error ?? '')
        else this.settleFailure(thread)
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
          if (!controller.signal.aborted && !thread.takeover)
            this.handOn(thread, spec, answerOf(seat.turn))
        }
        // A person answered: the messages that waited on them go now.
        if (turn.kind !== 'prompt' && turn.kind !== 'resume')
          await this.releaseHeld(thread, spec, seat)
      } catch (error) {
        console.error(`thread ${spec.sessionId}: turn failed`, error)
      } finally {
        started()
        this.options.folders.touch({ sessionId: spec.sessionId, teammateId: me })
        if (thread.running?.turnId === turnId) {
          thread.running = undefined
          thread.controller = undefined
        }
        this.pending--
        thread.slotWait = undefined
        if (acquired) this.release()
      }
    })
  }

  /**
   * A turn failed (its error shows in the thread). On a passing error (PASSING_ERROR) it is
   * tried again on its own, after RETRY_AFTER_MS, a few times; a full disk is tried again
   * once there is room on it. Else, and after those tries, a person tries it again
   * (thread.retry) or writes.
   */
  private failed(thread: Thread, spec: ThreadSpec, error: string, diskFull = false) {
    const tries = thread.failed?.tries ?? 0
    clearTimeout(thread.failed?.timer)
    thread.failed = { spec, error, tries }
    if (!PASSING_ERROR.test(error) || this.stopping || thread.takeover) return
    const name = spec.teammate.name
    const wait = RETRY_AFTER_MS[tries]
    if (wait === undefined)
      return this.say(
        spec.sessionId,
        `${name} tried again ${tries} times and the error came back. Try again once it is fixed.`,
      )
    this.say(
      spec.sessionId,
      `${diskFull ? "The computer's disk is still full. " : ''}${name} tries again in ${minutes(wait)}.`,
    )
    thread.failed.timer = setTimeout(() => void this.tryAgain(thread, tries + 1), wait)
  }

  /** A try of a failed turn, on its own (failed). */
  private async tryAgain(thread: Thread, tries: number) {
    const failed = thread.failed
    if (!failed || this.stopping || thread.takeover) return
    failed.timer = undefined
    failed.tries = tries
    if (DISK_ERROR.test(failed.error) && !(await roomOnDisk()))
      return this.failed(thread, failed.spec, failed.error, true)
    this.retryTurn(thread, failed)
  }

  /** A person asks to try the failed turn again now: the tries on its own start over. */
  private retry(spec: ThreadSpec, error: string | undefined) {
    const thread = this.thread(spec.sessionId)
    clearTimeout(thread.failed?.timer)
    thread.failed = { spec, error: error ?? thread.failed?.error ?? 'unknown error', tries: 0 }
    this.retryTurn(thread, thread.failed)
  }

  private retryTurn(thread: Thread, failed: NonNullable<Thread['failed']>) {
    // Busy again (a message came, another turn runs or waits): that goes on instead.
    if (
      thread.controller ||
      thread.messages.size > 0 ||
      [...thread.waiting.values()].some((n) => n > 0)
    )
      return
    this.enqueue(failed.spec, { kind: 'retry', error: failed.error })
  }

  /** No failed turn to try again any more: it went on, or someone wrote or stopped it. */
  private settleFailure(thread: Thread) {
    clearTimeout(thread.failed?.timer)
    thread.failed = undefined
  }

  private say(sessionId: string, value: string) {
    this.options.emit(sessionId, {
      at: new Date().toISOString(),
      type: 'raw',
      source: 'runner',
      value,
    })
  }

  /**
   * Nothing runs (but a turn answered already), waits or is queued in the thread: a message
   * can show at once.
   */
  private quiet(thread: Thread) {
    return (
      (!thread.controller || this.answered(thread)) &&
      !thread.memorizing &&
      thread.messages.size === 0 &&
      ![...thread.waiting.values()].some((n) => n > 0)
    )
  }

  /** The running turn is answered: only Claude Code's guess at the person's next message is left. */
  private answered(thread: Thread) {
    return !!thread.running && !!thread.harnesses.get(thread.running.teammateId)?.harness.answered
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
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      ...(message.attachments.length
        ? { attachments: message.attachments.map((a) => MessageAttachment.parse(a)) }
        : {}),
    })
    message.upTo = this.note(spec, null, 'A member', this.promptText(message, spec))
    return message.upTo
  }

  /**
   * What the teammate reads: the message it replies to, quoted; the text (a command
   * it starts with, in words: a harness takes a leading `/` for its own); and where
   * the files that came with it are.
   */
  private promptText(message: Message, spec: ThreadSpec) {
    const skills = (spec.skills ?? []).map((s) => s.name)
    return [
      replyLines(message.specs[0]!, message.replyTo),
      commandPrompt(message.text, skills),
      attachmentLines(message.attachments),
    ]
      .filter(Boolean)
      .join('\n\n')
  }

  private emitQueued(sessionId: string, message: Message, note?: string) {
    this.options.emit(sessionId, {
      at: new Date().toISOString(),
      type: 'message.queued',
      messageId: message.id,
      text: message.text,
      memberId: message.memberId,
      waitingFor: message.state === 'held' ? 'person' : 'turn',
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
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
    // Brigade's own (a child's report, a wake-up) goes to the teammate as it was.
    if (!mayChangeQueued(message.memberId, command.action)) return
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
          thread.takeover
            ? HELD_FOR_HANDBACK
            : `${name} is waiting for an answer. It runs once someone answers.`,
        )
      return
    }
    if (thread.slotWait?.teammateId === spec.teammate.id)
      return this.emitQueued(
        spec.sessionId,
        message,
        `${name} is waiting for ${turnsRunning(thread.slotWait.running)} to end, so it runs when its turn comes.`,
      )
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
      await seat.harness.steer(this.promptText(message, spec))
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

  /** The message's teammate runs a turn that only waits on its background work. */
  private waiting(thread: Thread, message: Message) {
    const teammateId = message.specs[0]!.teammate.id
    return thread.running?.teammateId === teammateId && !!thread.harnesses.get(teammateId)?.waiting
  }

  /**
   * The teammate's turn only waits on its background work: the oldest message
   * queued for it goes in now. The next one waits until the teammate answered it
   * and only waits again, so each message gets a reply of its own, as in a turn
   * of its own, rather than all of them read at once.
   */
  private steerQueued(thread: Thread, teammateId: string) {
    const seat = thread.harnesses.get(teammateId)
    if (!seat?.waiting) return
    const next = [...thread.messages.values()].find(
      (m) => m.state === 'queued' && m.specs[0]!.teammate.id === teammateId,
    )
    if (!next) return
    // Busy with it until the bridge says the turn only waits again.
    seat.waiting = false
    void this.steer(thread, next)
  }

  /** The teammate no longer waits on a person: the messages held for that are queued again. */
  private async releaseHeld(thread: Thread, spec: ThreadSpec, seat: Seat) {
    const held = [...thread.messages.values()].filter(
      (m) => m.state === 'held' && m.specs[0]!.teammate.id === spec.teammate.id,
    )
    if (held.length === 0 || thread.takeover || (await seat.harness.awaitingPerson())) return
    for (const message of held) {
      // Released meanwhile, or cancelled.
      if (message.state !== 'held') continue
      message.state = 'queued'
      // One already in the thread runs without showing as queued again.
      if (message.upTo) message.state = 'shown'
      else this.emitQueued(spec.sessionId, message)
      this.enqueueMessage(thread, message)
    }
  }

  /** releaseHeld, for each teammate with messages held. */
  private async releaseAllHeld(thread: Thread) {
    const held = new Map<string, ThreadSpec>()
    for (const message of thread.messages.values())
      if (message.state === 'held') held.set(message.specs[0]!.teammate.id, message.specs[0]!)
    for (const spec of held.values())
      await this.releaseHeld(thread, spec, this.harness(thread, spec))
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
          // Taken from the same log by the next runner, when the thread goes quiet there.
          if (this.stopping) return
          const speakers = spec.teammates.filter((t) => fresh.some((e) => e.by === t.id))
          const run = memoryRun({
            spec,
            entries: fresh,
            summary: log.summary,
            memory: this.options.context.memoryFor,
            speakers,
          })
          const text = await runOnce({
            spec,
            ...this.memoryWorkDir(spec),
            prompt: run.prompt,
            usage: { kind: 'memory', sessionId, teammateId: spec.teammate.id },
            signal: AbortSignal.any([AbortSignal.timeout(MEMORY_RUN_MS), this.stopped.signal]),
          })
          const update = run.parse(text)
          if (!update) return console.warn(`thread ${sessionId}: memory run gave no usable answer`)
          this.options.memoryUpdate({ type: 'memory.update', sessionId, ...update })
          log.memorized = end
          log.summary = update.summary
          await this.saveLog(sessionId)
          for (const file of run.tidyAfter(update)) this.tidy(spec, file)
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

  /**
   * Lay a memory file out again (memory-tidy.ts), on the account of the thread
   * that went quiet, beside it rather than in its queue: a tidy may take a few
   * minutes and the thread's next message should not wait for it. One at a time
   * per file on this computer; after a failure, not again for a while.
   */
  private tidy(spec: ThreadSpec, file: TidyFile) {
    const path = memoryFilePath(file.ref)
    const failed = this.tidyFailed.get(path)
    // The manifest may not say yet that this computer just tidied it.
    const sent = this.tidySent.get(path)
    // One at a time on this computer, and outside the turns' slots: a tidy waits, a turn does not.
    if (
      this.stopping ||
      this.tidying.size > 0 ||
      (failed && Date.now() - failed < TIDY_RETRY_MS) ||
      (sent && Date.now() - sent < TIDY_RESEND_MS)
    )
      return
    this.tidying.add(path)
    void (async () => {
      try {
        if (this.stopping) return
        const run = tidyRun(file)
        const text = await runOnce({
          spec,
          ...this.memoryWorkDir(spec, 'tidy-runs'),
          prompt: run.prompt,
          usage: { kind: 'tidy', sessionId: spec.sessionId, teammateId: spec.teammate.id },
          signal: AbortSignal.any([AbortSignal.timeout(TIDY_RUN_MS), this.stopped.signal]),
        })
        const layout = run.parse(text)
        if (!layout) {
          this.tidyFailed.set(path, Date.now())
          return console.warn(`memory ${path}: tidy run gave no usable layout`)
        }
        this.tidyFailed.delete(path)
        this.tidySent.set(path, Date.now())
        this.options.memoryTidy({
          type: 'memory.tidy',
          sessionId: spec.sessionId,
          file: file.ref,
          lastTidied: file.lastTidied,
          layout,
        })
      } catch (error) {
        this.tidyFailed.set(path, Date.now())
        console.warn(`memory ${path}: tidy run failed: ${String(error)}`)
      } finally {
        this.tidying.delete(path)
      }
    })()
  }

  /**
   * A new thread: a short run on its first message, beside its first turn,
   * names it with the harness's small model. On failure it keeps its first line.
   */
  private async name(spec: ThreadSpec, text: string, from: string) {
    try {
      const answer = await runOnce({
        spec,
        ...this.memoryWorkDir(spec, 'title-runs'),
        prompt: titlePrompt(text),
        model: TITLE_MODEL[spec.teammate.harness],
        purpose: 'title',
        usage: { kind: 'title', sessionId: spec.sessionId, teammateId: spec.teammate.id },
        signal: AbortSignal.timeout(TITLE_RUN_MS),
      })
      const title = parseTitle(answer)
      if (title && title !== from)
        this.options.title({ type: 'thread.title', sessionId: spec.sessionId, from, title })
    } catch (error) {
      console.warn(`thread ${spec.sessionId}: title run failed: ${String(error)}`)
    }
  }

  /** Where a memory or title run works: an empty directory of the teammate's, never the thread's. */
  private memoryWorkDir(spec: ThreadSpec, folder = 'memory-runs') {
    const user = CLOUD ? teammateUser(spec.teammate.id) : undefined
    return user
      ? { workDir: `${teammateHome(user)}/.${folder}/${spec.sessionId}`, runAs: user }
      : { workDir: join(paths.state, folder, spec.sessionId) }
  }

  /**
   * The prompt for a teammate's turn: what was said since its last one, up to
   * `upTo` when given. A lone member message to a teammate that already knows
   * the thread goes as is, so a thread with one teammate reads as before.
   * `onlyNew`: nothing at all when it has seen everything.
   */
  private async catchUp(spec: ThreadSpec, upTo?: number, onlyNew = false) {
    const thread = this.thread(spec.sessionId)
    const log = await thread.log
    const me = spec.teammate.id
    const known = me in log.seen
    const told = log.seen[me] ?? 0
    const end = Math.min(upTo ?? Infinity, log.start + log.entries.length)
    const from = Math.max(log.seen[me] ?? 0, log.start)
    const unseen = log.entries
      .map((e, i) => ({ ...e, at: log.start + i }))
      .slice(Math.max(0, from - log.start), Math.max(0, end - log.start))
      .filter((e) => e.by !== me)
    log.seen[me] = Math.max(log.seen[me] ?? 0, end)
    void this.saveLog(spec.sessionId)
    if (onlyNew && unseen.length === 0) return ''
    const others = spec.teammates.filter((t) => t.id !== me).map((t) => t.name)
    const last = unseen.at(-1)
    // A person's message alone, to a teammate that knows the thread: as they wrote it.
    if ((known || others.length === 0) && unseen.length === 1 && last?.by === null && !last.note)
      return last.text

    const ask = firstAsk(log)
    const lines = missedLines(
      unseen,
      CATCH_UP_CHARS,
      ask && ask.at >= told && ask.at < end ? ask : undefined,
    )
    return [
      others.length > 0 &&
        `You are ${spec.teammate.name}, one of the AI teammates in this thread, with ${others.join(', ')}. Each of you works in your own session and directory; here is what was said since your last turn. ` +
          `To have a teammate answer after you, mention them as @Name in your reply; mention one only when you need them to act now.`,
      lines.length > 0 && MARKS_RULE,
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
      push(log, { by, name, text })
      // What the speaker has seen moves only when it is told (catchUp): a message
      // that came in while it was replying is still unseen. Its own lines are skipped there.
      if (by && !(by in log.seen)) log.seen[by] = log.start + log.entries.length
      return log
    })
    thread.log = log
    void this.saveLog(spec.sessionId)
    return log.then((l) => l.start + l.entries.length)
  }

  /**
   * What memory learned since the teammate's session started, told once at the
   * start of a turn. A parked session loads all of it when it resumes: nothing to tell.
   */
  private memoryNews(spec: ThreadSpec, seat: Seat) {
    const loaded = seat.harness.memoryLoaded
    if (!loaded) return ''
    const memory = threadMemory(spec, this.options.context.memoryFor(spec.teammate.id), '')
    return memoryNews(memory, loaded, seat.told)
  }

  /**
   * Something that happened outside a turn (thread.note): a line in the thread,
   * and what each teammate is told at the start of its next turn.
   */
  async noteFromOutside(sessionId: string, text: string) {
    this.options.emit(sessionId, {
      at: new Date().toISOString(),
      type: 'raw',
      source: THREAD_NOTE_SOURCE,
      value: text,
    })
    const thread = this.thread(sessionId)
    thread.log = thread.log.then((log) => {
      push(log, { by: null, name: 'Brigade', text, note: true })
      return log
    })
    await this.saveLog(sessionId)
  }

  private logFile = (sessionId: string) => join(paths.state, `${sessionId}.team.json`)

  private async saveLog(sessionId: string) {
    const log = await this.thread(sessionId).log
    await mkdir(paths.state, { recursive: true, mode: 0o700 })
    // Whole or not at all: a stop without warning keeps the previous log.
    const temp = `${this.logFile(sessionId)}.${randomUUID()}.tmp`
    await writeFile(temp, JSON.stringify(log), { mode: 0o600 })
      .then(() => rename(temp, this.logFile(sessionId)))
      .catch((error) => console.warn(`could not save thread log: ${String(error)}`))
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
      const where = threadFolder(teammateId, spec.sessionId)
      const user = where.runAs
      const folder: Folder = { key: `${spec.sessionId}-${teammateId}`, ...where }
      const harness = new HarnessThread(
        spec,
        folder.workDir,
        paths.state,
        (event) => {
          // In a thread with several teammates, each event says whose it is.
          this.options.emit(spec.sessionId, { ...event, teammateId })
          if (event.type === 'message.done' && event.text.trim()) {
            this.note(spec, teammateId, spec.teammate.name, event.text)
            seat!.turn.push({ kind: 'message', chars: visibleChars(event.text), text: event.text })
            // The images it shows, kept with the thread: a file in /tmp is gone by tomorrow.
            void keepReplyImages(event.text, folder, spec.sessionId, this.options.storeImage).then(
              (images) =>
                Object.keys(images).length > 0 &&
                this.options.emit(spec.sessionId, {
                  at: new Date().toISOString(),
                  type: 'message.images',
                  id: event.id,
                  images,
                  teammateId,
                }),
              (error: unknown) =>
                console.warn(`could not read the images of a reply: ${String(error)}`),
            )
          }
          const background = backgroundTasks(event)
          if (background) seat!.background = background
          const waiting = backgroundWait(event)
          if (waiting !== undefined) {
            seat!.waiting = waiting
            if (waiting) this.steerQueued(thread, teammateId)
          }
          if (event.type === 'turn.completed') {
            seat!.waiting = false
            seat!.background = []
          }
          // Answered and handing on (handOn): the teammates it names start now, rather than wait
          // on a guess at the member's next message their answers are about to replace.
          if (
            event.type === 'turn.completed' &&
            seat!.harness.answered &&
            mentionedTeammates(answerOf(seat!.turn), seat!.spec ?? spec).some(
              (id) => id !== teammateId,
            )
          )
            void seat!.harness.stopDrain()
          if (event.type === 'tool.started')
            seat!.turn.push({
              kind: ASIDE_TOOLS.has(bareToolName(event.toolName)) ? 'other' : 'step',
            })
          // What the turn checked out, for the dashboard's Preview.
          if (event.type === 'turn.completed')
            void this.options.previews
              .reportCheckouts({
                sessionId: spec.sessionId,
                teammateId,
                workDir: folder.workDir,
                ...(user ? { runAs: user } : {}),
              })
              .catch(() => undefined)
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
      seat = {
        harness,
        folder,
        parkTimer: undefined,
        turn: [],
        waiting: false,
        told: new Set(),
        background: [],
      }
      thread.harnesses.set(teammateId, seat)
    }
    return seat
  }

  /** A slot for a turn or a memory run; `waits` is told when there is none free now. */
  private async acquire(waits?: (running: number) => void) {
    if (this.running < this.options.concurrency) {
      this.running++
      return
    }
    waits?.(this.running)
    await new Promise<void>((resolve) => this.waiters.push(resolve))
  }

  private release() {
    const next = this.waiters.shift()
    if (next) next()
    else this.running--
  }
}

/** Where a teammate works in a thread: on a cloud computer as its own Linux user, in its own home. */
export function threadFolder(teammateId: string, sessionId: string) {
  const user = CLOUD ? teammateUser(teammateId) : undefined
  return user
    ? { workDir: `${teammateHome(user)}/threads/${sessionId}`, runAs: user }
    : { workDir: paths.threadDir(teammateId, sessionId) }
}

/** "the turn running on this computer", "one of the 4 turns running on this computer". */
export const turnsRunning = (n: number) =>
  n === 1 ? 'the turn running on this computer' : `one of the ${n} turns running on this computer`

const minutes = (ms: number) =>
  ms < 60_000
    ? `${Math.round(ms / 1000)} seconds`
    : ms < 120_000
      ? '1 minute'
      : `${Math.round(ms / 60_000)} minutes`

/** Room on this computer's disk for a turn that failed on a full one. */
const roomOnDisk = () =>
  statfs(paths.state).then(
    (s) => s.bavail * s.bsize >= FREE_BYTES,
    () => true,
  )

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The teammates of the thread a reply mentions, in order: as a mention chip,
 * or as plain @Name (teammates write that). Longer names first, so "@Cody 2"
 * is not read as "@Cody".
 */
export function mentionedTeammates(text: string, spec: ThreadSpec) {
  // The chief may also bring in any teammate of the workspace.
  const reachable =
    spec.teammate.kind === 'chief'
      ? [
          ...spec.teammates,
          ...(spec.roster ?? []).filter((r) => !spec.teammates.some((t) => t.id === r.id)),
        ]
      : spec.teammates
  const found: { id: string; at: number }[] = []
  for (const id of mentionedIds(text, 'teammate'))
    if (reachable.some((t) => t.id === id)) found.push({ id, at: text.indexOf(id) })
  const names = [...reachable].sort((a, b) => b.name.length - a.name.length)
  let rest = text
  for (const t of names) {
    const pattern = new RegExp(`(^|[^\\w@])@${escape(t.name)}(?![\\w])`, 'gi')
    for (const m of rest.matchAll(pattern)) found.push({ id: t.id, at: m.index })
    rest = rest.replace(pattern, (whole) => ' '.repeat(whole.length))
  }
  return [...new Set(found.sort((a, b) => a.at - b.at).map((f) => f.id))]
}

/**
 * The earlier message a member replies to, quoted above their text. Named by
 * its author, not "your": every teammate in the thread reads the same line.
 */
export function replyLines(spec: ThreadSpec, reply?: ReplyTo) {
  if (!reply) return ''
  const author = reply.teammateId
    ? ([spec.teammate, ...spec.teammates].find((t) => t.id === reply.teammateId)?.name ??
      'a teammate')
    : 'a member'
  const quote = reply.text
    .trim()
    .split('\n')
    .map((line) => `> ${line}`.trimEnd())
    .join('\n')
  return `Replying to this earlier message from ${author}:\n${quote}`
}
