// What ends the waits of the tools that wait on work going on without them: a command on the
// thread's machine (run_on_machine, machine_run). The command goes on there; the call answers
// with it still running, and the teammate waits again with machine_run.
// - A message given to the running turn (steer): Claude Code and Codex read it between two
//   steps, with the next tool result, so a wait of ten minutes kept the person's message unread
//   for ten minutes. A wait under way ends as one comes in, and so does one that starts before
//   the turn read it.
// - The runner handing the turn over to the next one (an update, handOver): the harness lets go
//   of the turn only once the calls of its host are done, so a wait under way kept it past
//   HAND_OVER_MS, and the turn was stopped and started again, the command's id lost with the
//   call (Nov 6, 7 turns in an afternoon of merges). Every wait ends then, and any that starts
//   after it.

/** Why a wait ended before its time. */
export type Cut = 'message' | 'handover'

export type Watch = {
  /** Aborted when the call is, or once a message comes in or the turn is handed over. */
  signal: AbortSignal
  /** What ended it, but the call's own abort. */
  readonly cut: Cut | undefined
  /** The wait is over: stop listening. */
  release(): void
}

export class Arrivals {
  private readonly waits = new Set<(cut: Cut) => void>()
  /** A message went into the turn since it last got a tool's result: it has not read it yet. */
  private unread = false
  /** The turn is handed over to the next runner: this one's waits are over, for good. */
  private leaving = false

  /** A message was given to the running turn, which reads it with the next tool result. */
  arrived() {
    this.unread = true
    this.end('message')
  }

  /** The turn got a tool's result: what came before it goes in with it. */
  read() {
    this.unread = false
  }

  /** The runner hands the turn over (an update): no wait of this one may hold it. */
  handOver() {
    this.leaving = true
    this.end('handover')
  }

  /** A wait about to start, cut by the call's own abort (`signal`), a message or a hand-over. */
  watch(signal?: AbortSignal): Watch {
    const controller = new AbortController()
    let cut: Cut | undefined
    const onCut = (why: Cut) => {
      cut ??= why
      controller.abort()
    }
    const onAbort = () => controller.abort(signal?.reason)
    if (signal?.aborted) controller.abort(signal.reason)
    else if (this.leaving) onCut('handover')
    else if (this.unread) onCut('message')
    else {
      this.waits.add(onCut)
      signal?.addEventListener('abort', onAbort, { once: true })
    }
    return {
      signal: controller.signal,
      get cut() {
        return cut
      },
      release: () => {
        this.waits.delete(onCut)
        signal?.removeEventListener('abort', onAbort)
      },
    }
  }

  /** Waits listening now: none once each released (a test's check). */
  get listening() {
    return this.waits.size
  }

  private end(cut: Cut) {
    for (const end of [...this.waits]) end(cut)
  }
}
