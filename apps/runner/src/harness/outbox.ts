// A turn's events on their way out, in order, and the call a done block at the end of its reply
// stands for (declaredDone): the runner sends it to Brigade as the reply ends, and what the turn
// sends after it (its end, Claude Code's guess at the person's next message) waits for Brigade's
// answer, so the thread reads as when the teammate called complete_thread itself.
import { COMPLETE_THREAD_TOOL, type AgentEvent } from '@brigade/contracts'
import type { ScheduleCaller } from './tools.js'

/** The longest a turn's end waits for Brigade to declare its thread done (declareDone). */
export const DONE_WAIT_MS = 15_000

type Started = Extract<AgentEvent, { type: 'tool.started' }>
type Finished = Extract<AgentEvent, { type: 'tool.finished' }>

/** Events out at once, or after what holds the line (hold), in the order they were sent. */
export class Outbox {
  private tail: Promise<void> | undefined

  constructor(private readonly emit: (event: AgentEvent) => void) {}

  send(event: AgentEvent) {
    if (!this.tail) return this.emit(event)
    this.after(async () => this.emit(event))
  }

  /** What `work` gives goes out once it settles, before anything sent after this. */
  hold(work: Promise<AgentEvent[]>) {
    this.after(async () => {
      for (const event of await work) this.emit(event)
    })
  }

  /** Settles once all held and sent so far is out. */
  async flushed() {
    while (this.tail) await this.tail
  }

  private after(step: () => Promise<void>) {
    const tail = (this.tail ?? Promise.resolve()).then(step).catch((error: unknown) => {
      console.warn(`could not send a turn's event: ${String(error)}`)
    })
    this.tail = tail
    void tail.then(() => {
      if (this.tail === tail) this.tail = undefined
    })
  }
}

/**
 * A done block's call, sent to Brigade: its tool.finished with Brigade's answer. Declared done,
 * the thread shows its Done line; refused (something still open), failed or unanswered within
 * `waitMs`, an error the person sees under the reply, with why.
 */
export async function declareDone(
  call: ScheduleCaller,
  started: Started,
  waitMs = DONE_WAIT_MS,
): Promise<Finished> {
  const summary = String((started.input as { summary?: unknown } | null)?.summary ?? '')
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<{ output: unknown; isError: boolean }>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          output: { error: 'Brigade did not answer in time: the thread may not be declared done.' },
          isError: true,
        }),
      waitMs,
    )
  })
  const answer = call({
    operation: { name: COMPLETE_THREAD_TOOL, summary },
    toolCallId: started.toolCallId,
    toolName: COMPLETE_THREAD_TOOL,
    input: started.input,
  }).then(
    // Brigade refuses with what is still open, as an answer: an error all the same here.
    (output) => ({ output, isError: refused(output) }),
    (error: unknown) => ({
      output: { error: error instanceof Error ? error.message : String(error) },
      isError: true,
    }),
  )
  try {
    const { output, isError } = await Promise.race([answer, late])
    return {
      at: new Date().toISOString(),
      type: 'tool.finished',
      toolCallId: started.toolCallId,
      toolName: COMPLETE_THREAD_TOOL,
      output,
      isError,
    }
  } finally {
    clearTimeout(timer)
  }
}

const refused = (output: unknown) =>
  typeof output === 'object' &&
  output !== null &&
  typeof (output as { error?: unknown }).error === 'string'
