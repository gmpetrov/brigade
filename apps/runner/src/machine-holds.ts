// Who uses each thread's machine on this runner (the preview_machines feature, docs/previews.md):
// its preview (previews.ts) and the commands teammates run there (machine-runs.ts). The API starts
// the machine on `up` and stops it on `sleep`; with several users, the runner says `sleep` only
// once the last of them is done with it, and after a command, only once nobody came for a while
// (the next command of a turn often follows within minutes, and each start counts at the provider).
// A thread's ups and sleeps go to the API one after the other, so a sleep decided before an up
// never lands after it.
import type { PreviewMachineUp } from '@brigade/contracts'

export type MachineApi = {
  /** The thread's machine, running, with this key let in; { machine: null }: it has none. */
  up: (sessionId: string, publicKey: string) => Promise<PreviewMachineUp>
  /** Stop the thread's machine, its disk kept. */
  sleep: (sessionId: string) => Promise<unknown>
  /** Still in use: its machine is not stopped meanwhile. */
  touch: (sessionId: string) => Promise<unknown>
}

type Held = {
  /** Who uses the machine now: 'preview', or a command's 'run:<id>'. */
  holders: Set<string>
  /** The API calls for this thread, one after the other. */
  calls: Promise<unknown>
  /** Kept up until then for whoever comes next, once nobody holds it. */
  keepUntil: number
  timer?: NodeJS.Timeout
  /** The machine may be up: an up gave it since the last sleep. */
  up: boolean
}

export class MachineHolds {
  private readonly threads = new Map<string, Held>()

  constructor(private readonly api: MachineApi) {}

  /**
   * The thread's machine, up, for `holder`. When the API gives none (the thread has no machine,
   * or the workspace has too many up), the holder holds nothing.
   */
  async up(sessionId: string, holder: string, publicKey: string) {
    const held = this.held(sessionId)
    held.holders.add(holder)
    clearTimeout(held.timer)
    held.timer = undefined
    try {
      const answer = await this.call(held, () => this.api.up(sessionId, publicKey))
      if (answer.machine) held.up = true
      else void this.release(sessionId, holder)
      return answer
    } catch (error) {
      void this.release(sessionId, holder)
      throw error
    }
  }

  /**
   * `holder` is done with the machine: it stops once nobody holds it, and no sooner than `idleMs`
   * from now. Resolves once it stopped, or at once when it stays up (held, or kept a while).
   */
  release(sessionId: string, holder: string, idleMs = 0) {
    // Unknown here (nothing held it since the runner started): it may be up all the same.
    const known = this.threads.get(sessionId)
    const held = known ?? this.held(sessionId)
    if (!known) held.up = true
    held.holders.delete(holder)
    held.keepUntil = Math.max(held.keepUntil, Date.now() + idleMs)
    if (held.holders.size) return Promise.resolve()
    clearTimeout(held.timer)
    held.timer = undefined
    if (!held.up) {
      this.forget(sessionId, held)
      return Promise.resolve()
    }
    const wait = held.keepUntil - Date.now()
    if (wait <= 0) return this.sleepIfIdle(sessionId, held)
    held.timer = setTimeout(() => void this.sleepIfIdle(sessionId, held), wait)
    held.timer.unref()
    return Promise.resolve()
  }

  /** Still in use: said to the API as is. */
  touch(sessionId: string) {
    return this.api.touch(sessionId)
  }

  /** Who holds the thread's machine now. */
  holders(sessionId: string) {
    return [...(this.threads.get(sessionId)?.holders ?? [])]
  }

  private held(sessionId: string) {
    let held = this.threads.get(sessionId)
    if (!held) {
      held = { holders: new Set(), calls: Promise.resolve(), keepUntil: 0, up: false }
      this.threads.set(sessionId, held)
    }
    return held
  }

  /** After the thread's API calls under way: one at a time. */
  private call<T>(held: Held, work: () => Promise<T>): Promise<T> {
    const result = held.calls.then(work)
    held.calls = result.catch(() => undefined)
    return result
  }

  /** Nobody holds it and nothing is pending: the thread is forgotten. */
  private forget(sessionId: string, held: Held) {
    if (!held.holders.size && !held.timer && !held.up && this.threads.get(sessionId) === held)
      this.threads.delete(sessionId)
  }

  /** Nobody holds it and its time is up: it stops, judged again once the calls before it are done. */
  private sleepIfIdle(sessionId: string, held: Held) {
    held.timer = undefined
    return this.call(held, async () => {
      if (held.holders.size || Date.now() < held.keepUntil) return
      await this.api.sleep(sessionId)
      held.up = false
    })
      .catch((error: unknown) =>
        console.warn(`the machine of ${sessionId} did not stop: ${String(error)}`),
      )
      .finally(() => this.forget(sessionId, held))
  }
}
