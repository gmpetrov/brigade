// The whole computer running out of memory, watched by the runner itself:
// nothing else acts before it is too late. Swap keeps the kernel from killing
// at once, but a computer that swaps all the time crawls: whatever it runs
// waits on memory most of the time, it stops answering for many minutes, and
// its provider may not even manage to stop it. So when the computer has waited
// on memory too long (PSI "full", all of it), or memory and swap are nearly
// gone, the runner gives memory back itself, what costs least first:
//   1. the frozen preview unused longest, when swap is what runs out;
//   2. a teammate's browser no turn used for a while, the biggest: it starts
//      again at the next browser tool call, its sign-ins kept in its profile;
//   3. the running preview, browser or turn holding the most memory, a preview
//      or browser counting double (it starts again at the next visit or call;
//      a turn loses its work in progress), said in its thread.
// One at a time, then a pause to see what it changed. Where the runner has no
// cgroups of its own (preview-cgroup.ts), there is nothing it could stop.
import { readFile } from 'node:fs/promises'

/** The computer's memory now. */
export type Reading = {
  /** Share of the last 10 s in which everything waited on memory (PSI "full avg10"), in %. */
  full: number
  /** Memory available, as a share of all of it. */
  available: number
  /** Swap used, as a share of all of it; 0 without swap. */
  swapUsed: number
  swapTotal: number
  /** Processes the kernel has killed for memory since it started (/proc/vmstat oom_kill). */
  oomKills?: number
}

/** What the guard may stop to give memory back. */
export type Candidate = {
  kind: 'frozen' | 'preview' | 'turn' | 'browser'
  /** Its own memory in RAM. */
  memory: number
  /** When it was last used, for frozen previews and browsers. */
  lastUsed?: number
  stop: (why: string) => Promise<unknown>
}

const GB = 1024 ** 3
/** Less than this is not worth stopping: it would not change much. */
const SMALL = 64 * 1024 ** 2
/** A browser no turn used for this long is stopped before anything that runs. */
const BROWSER_IDLE = 2 * 60_000

export class MemoryGuard {
  private since: number | undefined
  private quietUntil = 0
  private checking = false
  private oomKills: number | undefined
  private timer: NodeJS.Timeout | undefined

  constructor(
    private readonly options: {
      candidates: () => Promise<Candidate[]>
      read?: () => Promise<Reading | null>
      /** Stalled this much of the time (PSI full, in %)… */
      limit?: number
      /** …for this long: act. */
      duration?: number
      /** After acting, the pressure averages need this long to show its effect. */
      cooldown?: number
    },
  ) {}

  private get limit() {
    return this.options.limit ?? (Number(process.env.BRIGADE_MEMORY_PRESSURE) || 40)
  }
  private get duration() {
    return this.options.duration ?? (Number(process.env.BRIGADE_MEMORY_PRESSURE_MS) || 10_000)
  }

  start(every = 2_000) {
    this.timer = setInterval(() => void this.tick().catch(() => undefined), every)
    this.timer.unref()
  }

  stop() {
    clearInterval(this.timer)
  }

  /** Why the computer needs memory back now, or nothing. */
  check(reading: Reading, now: number): string | undefined {
    if (reading.full >= this.limit) this.since ??= now
    else this.since = undefined
    // The kernel just killed something for memory itself: see what that changed first.
    if (this.killedByKernel(reading)) this.pause(now)
    if (now < this.quietUntil) return undefined
    if (reading.available < 0.03 && (reading.swapTotal === 0 || reading.swapUsed > 0.9))
      return 'the computer is nearly out of memory'
    if (this.since !== undefined && now - this.since >= this.duration)
      return `the computer was stuck waiting for memory for ${Math.round((now - this.since) / 1000)} s`
    return undefined
  }

  private killedByKernel(reading: Reading) {
    const before = this.oomKills
    if (reading.oomKills !== undefined) this.oomKills = reading.oomKills
    return before !== undefined && reading.oomKills !== undefined && reading.oomKills > before
  }

  private pause(now: number) {
    this.quietUntil = now + (this.options.cooldown ?? 20_000)
    this.since = undefined
  }

  /** What to stop for it, the least costly that helps. */
  pick(candidates: Candidate[], reading: Reading, now = Date.now()): Candidate | undefined {
    const frozen = candidates
      .filter((c) => c.kind === 'frozen')
      .sort((a, b) => (a.lastUsed ?? 0) - (b.lastUsed ?? 0))
    // Frozen previews hold swap, hardly any memory: they help when swap is what runs out.
    if (frozen[0] && reading.swapTotal > 0 && reading.swapUsed > 0.8) return frozen[0]
    const idle = candidates
      .filter((c) => c.kind === 'browser' && c.memory >= SMALL)
      .filter((c) => now - (c.lastUsed ?? 0) >= BROWSER_IDLE)
      .sort((a, b) => b.memory - a.memory)
    if (idle[0]) return idle[0]
    const weight = (c: Candidate) => c.memory * (c.kind === 'turn' ? 1 : 2)
    const running = candidates
      .filter((c) => c.kind !== 'frozen' && c.memory >= SMALL)
      .sort((a, b) => weight(b) - weight(a))
    return running[0] ?? frozen[0]
  }

  async tick(now = Date.now()) {
    // One at a time: on a computer stuck waiting for memory, a check can take longer than the
    // interval, and checks piling up would each stop something (seen: three turns at once).
    if (this.checking) return
    this.checking = true
    try {
      const reading = await (this.options.read ?? readMemory)()
      if (!reading) return
      const why = this.check(reading, now)
      if (!why) return
      this.pause(now)
      const victim = this.pick(await this.options.candidates(), reading, now)
      if (!victim) {
        console.warn(`${why}, and no preview, browser or turn of the runner's holds much of it`)
        return
      }
      // Stuck, the kernel may have killed something meanwhile: then that was enough for now.
      const last = await (this.options.read ?? readMemory)()
      if (last && this.killedByKernel(last)) return
      console.warn(`${why}: stopping a ${victim.kind} (${(victim.memory / GB).toFixed(1)} GB)`)
      await victim.stop(why)
    } finally {
      this.checking = false
    }
  }
}

/**
 * Whether the computer has room for a turn to start: some memory available and hardly any
 * waiting on it. Short of that, a new turn would only push the guard to stop another.
 */
export function roomFor(reading: Reading) {
  return reading.available >= 0.15 && reading.full < 10
}

/** The most turns a runner runs at once by default where its memory decides (roomFor): a safety cap. */
export const MOST_TURNS = 32

/**
 * How many turns a runner runs at once by default. Where it reads its memory (the guard's, on a
 * cloud computer), that memory decides, up to MOST_TURNS. Elsewhere (a member's Mac, which runs
 * their own apps too), one per 2 GB of memory, 8 to MOST_TURNS.
 */
export function turnsAtOnce(memory: number, readsMemory: boolean) {
  if (readsMemory) return MOST_TURNS
  return Math.min(MOST_TURNS, Math.max(8, Math.round(memory / (2 * GB))))
}

/** The computer has room for a turn (roomFor); true where it says nothing of its memory. */
export async function memoryRoom() {
  const reading = await readMemory()
  return !reading || roomFor(reading)
}

/** The computer's memory, from /proc; null where it says nothing of it (not Linux). */
export async function readMemory(): Promise<Reading | null> {
  const [pressure, meminfo, vmstat] = await Promise.all([
    readFile('/proc/pressure/memory', 'utf8').catch(() => ''),
    readFile('/proc/meminfo', 'utf8').catch(() => ''),
    readFile('/proc/vmstat', 'utf8').catch(() => ''),
  ])
  return parseMemory(pressure, meminfo, vmstat)
}

export function parseMemory(pressure: string, meminfo: string, vmstat = ''): Reading | null {
  const kB = (key: string) =>
    Number(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(meminfo)?.[1] ?? NaN)
  const total = kB('MemTotal')
  if (!pressure || !(total > 0)) return null
  const swapTotal = kB('SwapTotal') || 0
  return {
    full: Number(/^full avg10=([\d.]+)/m.exec(pressure)?.[1] ?? 0),
    available: (kB('MemAvailable') || 0) / total,
    swapUsed: swapTotal > 0 ? 1 - (kB('SwapFree') || 0) / swapTotal : 0,
    swapTotal: swapTotal * 1024,
    ...(/^oom_kill (\d+)$/m.test(vmstat)
      ? { oomKills: Number(/^oom_kill (\d+)$/m.exec(vmstat)![1]) }
      : {}),
  }
}
