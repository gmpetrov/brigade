// Runs threads on this computer: one harness session per teammate in a thread,
// turns of a thread in order (several teammates answer one after another), and
// at most `concurrency` turns at once across threads.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  mentionedIds,
  type AgentEvent,
  type ApiToRunner,
  type ThreadSpec,
} from '@brigade/contracts'
import { CLOUD, paths } from './config.js'
import { teammateHome, teammateUser } from './teammates.js'
import {
  HarnessThread,
  type ConnectorCaller,
  type CredentialRequester,
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

type Command = Extract<
  ApiToRunner,
  { type: 'thread.prompt' | 'thread.approval' | 'thread.answer' | 'thread.interrupt' }
>

/** Who said what in a thread, so each teammate can be told what it missed. Never a credential. */
type Log = {
  /** Index of entries[0] since the thread began; older entries are dropped. */
  start: number
  entries: { by: string | null; name: string; text: string }[]
  /** Per teammate: the index up to which it has been told. */
  seen: Record<string, number>
}

type Thread = {
  /** One harness session per teammate, by teammate id. */
  harnesses: Map<
    string,
    { harness: HarnessThread; parkTimer: NodeJS.Timeout | undefined; reply?: string }
  >
  queue: Promise<void>
  controller: AbortController | undefined
  /** Set while a person holds control: no teammate acts in the thread. */
  takeover?: { memberId: string; since: number }
  log: Promise<Log>
  /** Turns queued and not yet started, by teammate id. */
  waiting: Map<string, number>
  /** Handoffs since a member last wrote. */
  handoffs: number
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
      ) => Promise<unknown>
      requestCredential: (
        sessionId: string,
        teammateId: string,
        request: Parameters<CredentialRequester>[0],
      ) => Promise<unknown>
      /** A teammate's reply mentioned others in the thread: ask the API to have them answer next. */
      handoff: (sessionId: string, fromTeammateId: string, teammateIds: string[]) => void
    },
  ) {}

  handle(command: Command) {
    if (command.type === 'thread.interrupt') {
      this.threads.get(command.sessionId)?.controller?.abort()
      return
    }
    const spec = command.thread
    const specs = command.type === 'thread.prompt' ? [spec, ...command.then] : [spec]
    if (!SAFE_ID.test(spec.sessionId) || specs.some((s) => !SAFE_ID.test(s.teammate.id)))
      throw new Error('Invalid thread id')
    const at = new Date().toISOString()
    if (this.threads.get(spec.sessionId)?.takeover) {
      this.options.emit(spec.sessionId, {
        at,
        type: 'raw',
        source: 'runner',
        value: 'A person has control of this thread. Hand it back first.',
      })
      return
    }
    if (command.type === 'thread.prompt' && command.handoff) {
      // Nobody wrote anything: each is told what was said since its last turn.
      for (const next of specs) this.enqueue(next, 'prompt')
      return
    }
    if (command.type === 'thread.prompt') {
      this.thread(spec.sessionId).handoffs = 0
      this.options.emit(spec.sessionId, {
        at,
        type: 'message.user',
        text: command.text,
        memberId: command.memberId,
      })
      const upTo = this.note(spec, null, 'A member', command.text)
      // Each teammate in turn, told what was said since its last turn: the first up to this
      // message, those after it also their predecessors' replies.
      for (const [i, next] of specs.entries())
        this.enqueue(next, 'prompt', i === 0 ? upTo : undefined)
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

  /** A person takes control: the teammate stops now, or after its current turn. */
  takeover(spec: ThreadSpec, memberId: string, interrupt: boolean) {
    const thread = this.thread(spec.sessionId)
    if (thread.takeover) return
    thread.takeover = { memberId, since: Date.now() }
    if (interrupt) thread.controller?.abort()
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
    const files = await changedFiles(takeover.since).catch(() => [])
    thread.takeover = undefined
    const at = new Date().toISOString()
    this.options.emit(spec.sessionId, {
      at,
      type: 'control.changed',
      controller: 'teammate',
      memberId,
    })
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
    this.enqueue(spec, 'prompt', this.note(spec, null, 'A member', text))
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
   */
  private enqueue(spec: ThreadSpec, input: ThreadInput | 'prompt', upTo?: Promise<number>) {
    const thread = this.thread(spec.sessionId)
    const seat = this.harness(thread, spec)
    clearTimeout(seat.parkTimer)
    this.pending++
    const me = spec.teammate.id
    thread.waiting.set(me, (thread.waiting.get(me) ?? 0) + 1)
    thread.queue = thread.queue.then(async () => {
      thread.waiting.set(me, thread.waiting.get(me)! - 1)
      // Taken over while waiting in the queue: the turn does not happen.
      if (thread.takeover) return void this.pending--
      await this.acquire()
      const controller = new AbortController()
      thread.controller = controller
      try {
        const turn =
          input === 'prompt'
            ? { kind: 'prompt' as const, text: await this.catchUp(spec, await upTo) }
            : input
        this.options.emit(spec.sessionId, {
          at: new Date().toISOString(),
          type: 'turn.started',
          teammateId: spec.teammate.id,
          accountId: spec.account.id,
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
          seat.parkTimer = setTimeout(
            () => void seat.harness.park().catch(console.error),
            PARK_AFTER_MS,
          )
          if (!controller.signal.aborted && !thread.takeover) this.handOn(thread, spec, seat.reply)
        }
      } catch (error) {
        console.error(`thread ${spec.sessionId}: turn failed`, error)
      } finally {
        thread.controller = undefined
        this.pending--
        this.release()
      }
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
      // The speaker has seen everything up to and including what it said.
      if (by) log.seen[by] = log.start + log.entries.length
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

  private harness(thread: Thread, spec: ThreadSpec) {
    const teammateId = spec.teammate.id
    let seat = thread.harnesses.get(teammateId)
    if (!seat) {
      // On a cloud computer each teammate runs as its own Linux user, in its own home.
      const user = CLOUD ? teammateUser(teammateId) : undefined
      const harness = new HarnessThread(
        spec,
        user
          ? `${teammateHome(user)}/threads/${spec.sessionId}`
          : paths.threadDir(teammateId, spec.sessionId),
        paths.state,
        (event) => {
          // In a thread with several teammates, each event says whose it is.
          this.options.emit(spec.sessionId, { ...event, teammateId })
          if (event.type === 'message.done' && event.text.trim()) {
            this.note(spec, teammateId, spec.teammate.name, event.text)
            seat!.reply = event.text
          }
        },
        (call) => this.options.callConnector(spec.sessionId, teammateId, call),
        (request) => this.options.requestCredential(spec.sessionId, teammateId, request),
        user,
      )
      seat = { harness, parkTimer: undefined }
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
