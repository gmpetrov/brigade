// Who uses each thread's machine on this runner (the preview_machines feature, docs/previews.md):
// its preview (previews.ts) and the commands teammates run there (machine-runs.ts). The API starts
// the machine on `up` and stops it on `sleep`; with several users, the runner says `sleep` only
// once the last of them is done with it, and after a command, only once nobody came for a while
// (the next command of a turn often follows within minutes, and each start counts at the provider).
// A thread's ups and sleeps go to the API one after the other, so a sleep decided before an up
// never lands after it. Which threads' machines may be up, and when each may stop, is kept in a
// state file: the next runner (an update, a restart) stops them when this one would have.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { PreviewMachineUp } from '@brigade/contracts'

export type MachineApi = {
  /** The thread's machine, running, with this key let in; { machine: null }: it has none. */
  up: (sessionId: string, publicKey: string) => Promise<PreviewMachineUp>
  /** Stop the thread's machine, its disk kept. */
  sleep: (sessionId: string) => Promise<unknown>
  /**
   * Still in use: its machine is not stopped meanwhile. `busy`: a command runs there, and the
   * runner's computer stays up too.
   */
  touch: (sessionId: string, busy?: boolean) => Promise<unknown>
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

/** What the state file keeps: each thread whose machine may be up, and its keepUntil. */
type Saved = [sessionId: string, keepUntil: number][]

export class MachineHolds {
  private readonly threads = new Map<string, Held>()
  /**
   * The runner took up what the one before it left (rearm). Until then no machine is stopped:
   * a command it follows again, or a preview it takes up, may not hold it yet.
   */
  private settled: boolean

  constructor(
    private readonly api: MachineApi,
    private readonly options: {
      /**
       * Where the threads whose machine may be up are kept, with when each may stop: the next
       * runner stops them then (rearm). Without one, nothing outlives this runner.
       */
      stateFile?: string
    } = {},
  ) {
    this.settled = !options.stateFile
    if (!options.stateFile) return
    let saved: Saved = []
    try {
      saved = JSON.parse(readFileSync(options.stateFile, 'utf8')) as Saved
    } catch {
      // None yet.
    }
    // Nobody holds them here yet: those still in use are held again as they are taken up.
    for (const [sessionId, keepUntil] of Array.isArray(saved) ? saved : [])
      if (typeof sessionId === 'string' && typeof keepUntil === 'number')
        this.threads.set(sessionId, {
          holders: new Set(),
          calls: Promise.resolve(),
          keepUntil,
          up: true,
        })
  }

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
    this.save()
    if (held.holders.size) return Promise.resolve()
    // Kept up a while for whoever comes next: said to the API now, so that its stop of a machine
    // nobody touched (the sweep's UNUSED_STOP_MS) counts from here, not from the last touch.
    if (held.up && idleMs > 0)
      void this.api
        .touch(sessionId)
        .catch((error: unknown) =>
          console.warn(`the machine of ${sessionId}: could not say it is kept: ${String(error)}`),
        )
    return this.arm(sessionId, held)
  }

  /**
   * Once the runner took up what the one before it left (the previews it handed over taken up,
   * its commands followed again: each holds its machine again): every machine nobody holds stops
   * when it was due to, at once if that passed. Only the first call does anything.
   */
  rearm() {
    if (this.settled) return
    this.settled = true
    for (const [sessionId, held] of [...this.threads])
      if (!held.holders.size) void this.arm(sessionId, held)
  }

  /** Still in use: said to the API as is. */
  touch(sessionId: string, busy = false) {
    return this.api.touch(sessionId, busy)
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
      this.save()
    }
    return held
  }

  /**
   * Nobody holds it: it stops at its keepUntil, at once if that passed; not before the runner
   * settled (rearm judges it then). Resolves once it stopped, or at once when it stays up.
   */
  private arm(sessionId: string, held: Held) {
    clearTimeout(held.timer)
    held.timer = undefined
    if (!held.up) {
      this.forget(sessionId, held)
      return Promise.resolve()
    }
    if (!this.settled) return Promise.resolve()
    const wait = held.keepUntil - Date.now()
    if (wait <= 0) return this.sleepIfIdle(sessionId, held)
    held.timer = setTimeout(() => void this.sleepIfIdle(sessionId, held), wait)
    held.timer.unref()
    return Promise.resolve()
  }

  /** After the thread's API calls under way: one at a time. */
  private call<T>(held: Held, work: () => Promise<T>): Promise<T> {
    const result = held.calls.then(work)
    held.calls = result.catch(() => undefined)
    return result
  }

  /** Nobody holds it and nothing is pending: the thread is forgotten. */
  private forget(sessionId: string, held: Held) {
    if (!held.holders.size && !held.timer && !held.up && this.threads.get(sessionId) === held) {
      this.threads.delete(sessionId)
      this.save()
    }
  }

  /** The threads whose machine may be up, and when each may stop: for the runner after this one. */
  private save() {
    const file = this.options.stateFile
    if (!file) return
    const saved: Saved = [...this.threads].map(([sessionId, held]) => [sessionId, held.keepUntil])
    try {
      mkdirSync(dirname(file), { recursive: true })
      const temp = `${file}.${process.pid}.tmp`
      writeFileSync(temp, JSON.stringify(saved))
      renameSync(temp, file)
    } catch (error) {
      console.warn(`could not save which threads' machines may be up: ${String(error)}`)
    }
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
