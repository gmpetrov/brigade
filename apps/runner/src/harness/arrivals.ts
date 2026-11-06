// Messages given to a running turn (steer), for the tools that wait on work going on without
// them: a command on the thread's machine (run_on_machine, machine_run). Claude Code and Codex
// read such a message between two steps, with the next tool result: a wait of ten minutes kept
// the person's message unread for ten minutes. A wait under way ends as one comes in, and so
// does one that starts before the turn read it; the work goes on, and the teammate waits again
// once it has read it.

export type Watch = {
  /** Aborted when the call is, or once a message comes in. */
  signal: AbortSignal
  /** Whether a message ended it (not the call's own abort). */
  readonly byMessage: boolean
  /** The wait is over: stop listening. */
  release(): void
}

export class Arrivals {
  private readonly waits = new Set<() => void>()
  /** A message went into the turn since it last got a tool's result: it has not read it yet. */
  private unread = false

  /** A message was given to the running turn, which reads it with the next tool result. */
  arrived() {
    this.unread = true
    for (const end of [...this.waits]) end()
  }

  /** The turn got a tool's result: what came before it goes in with it. */
  read() {
    this.unread = false
  }

  /** A wait about to start, cut by the call's own abort (`signal`) or a message. */
  watch(signal?: AbortSignal): Watch {
    const controller = new AbortController()
    let byMessage = false
    const onMessage = () => {
      byMessage = true
      controller.abort()
    }
    const onAbort = () => controller.abort(signal?.reason)
    if (signal?.aborted) controller.abort(signal.reason)
    else if (this.unread) onMessage()
    else {
      this.waits.add(onMessage)
      signal?.addEventListener('abort', onAbort, { once: true })
    }
    return {
      signal: controller.signal,
      get byMessage() {
        return byMessage
      },
      release: () => {
        this.waits.delete(onMessage)
        signal?.removeEventListener('abort', onAbort)
      },
    }
  }

  /** Waits listening now: none once each released (a test's check). */
  get listening() {
    return this.waits.size
  }
}
