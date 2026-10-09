// Runs threads on this computer: one harness session per thread, turns of a
// thread in order, and at most `concurrency` turns at once across threads.
import type { AgentEvent, ApiToRunner, ThreadSpec } from '@brigade/contracts'
import { CLOUD, paths } from './config.js'
import { teammateHome, teammateUser } from './teammates.js'
import { HarnessThread, type ConnectorCaller, type ThreadInput } from './harness/index.js'

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/
/** Park an idle harness session after this long; the next message resumes it. */
const PARK_AFTER_MS = 5 * 60_000

type Command = Extract<
  ApiToRunner,
  { type: 'thread.prompt' | 'thread.approval' | 'thread.answer' | 'thread.interrupt' }
>

type Thread = {
  harness: HarnessThread
  queue: Promise<void>
  controller: AbortController | undefined
  parkTimer: NodeJS.Timeout | undefined
  /** Set while a person holds control: the teammate does not act in the thread. */
  takeover?: { memberId: string; since: number }
}

export class Threads {
  private threads = new Map<string, Thread>()
  private running = 0
  private waiters: Array<() => void> = []

  constructor(
    private readonly options: {
      concurrency: number
      emit: (sessionId: string, event: AgentEvent) => void
      callConnector: (sessionId: string, call: Parameters<ConnectorCaller>[0]) => Promise<unknown>
    },
  ) {}

  handle(command: Command) {
    if (command.type === 'thread.interrupt') {
      this.threads.get(command.sessionId)?.controller?.abort()
      return
    }
    const spec = command.thread
    if (!SAFE_ID.test(spec.sessionId) || !SAFE_ID.test(spec.teammate.id))
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
    let input: ThreadInput
    if (command.type === 'thread.prompt') {
      this.options.emit(spec.sessionId, {
        at,
        type: 'message.user',
        text: command.text,
        memberId: command.memberId,
      })
      input = { kind: 'prompt', text: command.text }
    } else if (command.type === 'thread.answer') {
      this.options.emit(spec.sessionId, {
        at,
        type: 'question.answered',
        questionId: command.questionId,
        answer: command.answer,
        memberId: command.memberId,
      })
      input = { kind: 'answer', questionId: command.questionId, answer: command.answer }
    } else {
      this.options.emit(spec.sessionId, {
        at,
        type: 'approval.resolved',
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
    const thread = this.thread(spec)
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
    const thread = this.thread(spec)
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
    this.enqueue(spec, { kind: 'prompt', text })
  }

  /** Stop every harness session, keeping saved state. Called on shutdown. */
  async parkAll() {
    await Promise.all(
      [...this.threads.values()].map((t) => t.harness.park().catch(() => undefined)),
    )
  }

  private enqueue(spec: ThreadSpec, input: ThreadInput) {
    const thread = this.thread(spec)
    clearTimeout(thread.parkTimer)
    thread.queue = thread.queue.then(async () => {
      await this.acquire()
      const controller = new AbortController()
      thread.controller = controller
      try {
        const outcome = await thread.harness.run(input, spec, controller.signal)
        if (outcome.status === 'waiting' && outcome.error) {
          this.options.emit(spec.sessionId, {
            at: new Date().toISOString(),
            type: 'raw',
            source: 'runner',
            value: outcome.error,
          })
        }
        if (outcome.status === 'idle') {
          thread.parkTimer = setTimeout(
            () => void thread.harness.park().catch(console.error),
            PARK_AFTER_MS,
          )
        }
      } finally {
        thread.controller = undefined
        this.release()
      }
    })
  }

  private thread(spec: ThreadSpec): Thread {
    let thread = this.threads.get(spec.sessionId)
    if (!thread) {
      // On a cloud computer each teammate runs as its own Linux user, in its own home.
      const user = CLOUD ? teammateUser(spec.teammate.id) : undefined
      const harness = new HarnessThread(
        spec,
        user
          ? `${teammateHome(user)}/threads/${spec.sessionId}`
          : paths.threadDir(spec.teammate.id, spec.sessionId),
        paths.state,
        (event) => this.options.emit(spec.sessionId, event),
        (call) => this.options.callConnector(spec.sessionId, call),
        user,
      )
      thread = { harness, queue: Promise.resolve(), controller: undefined, parkTimer: undefined }
      this.threads.set(spec.sessionId, thread)
    }
    return thread
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
