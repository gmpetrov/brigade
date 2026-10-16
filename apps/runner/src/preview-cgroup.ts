// Previews in cgroups of their own, on a cloud computer. The runner's service
// delegates its cgroup to the runner (Delegate=, DelegateSubgroup=runner in its
// unit), which starts in runner/ with its harnesses and gives previews a subtree:
//
//   brigade-runner.service/
//     runner/        the runner and the harnesses, where systemd starts it
//     previews/      every preview together: a ceiling below what the computer has,
//       <thread>/    and a lower CPU weight; one preview: its own ceiling, killed as
//                    one when it reaches it, frozen while nobody uses it
//
// So a preview that grows too big is what gets killed, not the runner or a turn,
// and a preview nobody uses stops taking CPU and gives its memory back (to swap)
// until the next request thaws it. Where the runner has no such tree (a member's
// machine, a computer set up before the delegation), previews run as before.
import { constants } from 'node:fs'
import { access, mkdir, readFile, readdir, rmdir, writeFile } from 'node:fs/promises'
import { totalmem } from 'node:os'
import { basename, dirname, join } from 'node:path'

const ROOT = '/sys/fs/cgroup'
const GiB = 1024 ** 3
const MiB = 1024 ** 2

/** Bytes from a setting such as "4G" or "512M"; undefined when unset or unreadable. */
function bytes(value: string | undefined) {
  const match = /^(\d+(?:\.\d+)?)([KMG]?)$/i.exec(value?.trim() ?? '')
  if (!match) return undefined
  const unit = { '': 1, K: 1024, M: MiB, G: GiB }[match[2]!.toUpperCase() as '' | 'K' | 'M' | 'G']
  return Math.round(Number(match[1]) * unit)
}

/**
 * What previews may take of the computer's memory. The rest stays for the
 * system and its desktop, the runner and the harnesses of running turns:
 * 1.5 GiB and an eighth of the memory (2.5 GiB of 8, 3.5 of 16).
 */
export function previewBudget(total = totalmem(), env = process.env) {
  const reserve = bytes(env.BRIGADE_PREVIEWS_RESERVE) ?? 1.5 * GiB + total / 8
  // Reclaimed and slowed down past this, together…
  const high = Math.max(GiB, total - reserve)
  // …killed (the biggest preview) past this. Swap does not count.
  const max = Math.max(high, total - reserve / 2)
  // One preview alone: at most half the computer, so one that runs away leaves room.
  const each = Math.min(bytes(env.BRIGADE_PREVIEW_MEMORY_MAX) ?? total / 2, max)
  return { high, max, each }
}

const round = (n: number) => String(Math.floor(n / MiB) * MiB)

/**
 * Swap one running preview may fill: some, for pages it does not touch, but not
 * all of it, which frozen previews need. A frozen one may push out everything.
 */
const RUNNING_SWAP = String(GiB)

async function write(dir: string, file: string, value: string) {
  await writeFile(join(dir, file), value)
}

/** The controllers a cgroup's children may use, enabled as far as the kernel and systemd allow. */
async function enable(dir: string) {
  const offered = (await readFile(join(dir, 'cgroup.controllers'), 'utf8')).split(/\s+/)
  const wanted = ['memory', 'cpu', 'pids'].filter((c) => offered.includes(c))
  if (wanted.length)
    await write(dir, 'cgroup.subtree_control', wanted.map((c) => `+${c}`).join(' '))
  return wanted
}

/** A number from a flat keyed file such as memory.events ("oom_kill 1"). */
async function keyed(file: string, key: string) {
  const text = await readFile(file, 'utf8').catch(() => '')
  return Number(new RegExp(`^${key} (\\d+)$`, 'm').exec(text)?.[1] ?? 0)
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

/** A preview cgroup's OOM counts (memory.events): kills in it, and the limits behind them. */
export type Ooms = {
  /** Its processes the kernel killed for memory. */
  kills: number
  /** Times it reached its own ceiling. */
  atCeiling: number
  /** Times the previews together reached theirs (previews/). */
  together: number
}

/**
 * Why the kernel killed a preview, from its cgroup's OOM counts when it started
 * and when it stopped; undefined when it did not. Neither ceiling reached: the
 * whole computer ran out.
 */
export function oomReason(
  before: Ooms | undefined,
  after: Ooms,
  budget: { max: number; each: number },
) {
  if (after.kills <= (before?.kills ?? 0)) return undefined
  if (after.atCeiling > (before?.atCeiling ?? 0))
    return `ran out of memory: a preview may use ${gb(budget.each)} here`
  if (after.together > (before?.together ?? 0))
    return `was killed: previews here may use ${gb(budget.max)} together`
  return 'was killed: the computer ran out of memory'
}

const gb = (n: number) => `${(n / GiB).toFixed(1)} GB`

/**
 * Previews stalled on memory, watched as systemd-oomd watches a unit: one whose
 * processes all waited on memory at least `limit` % of the time (PSI "full",
 * over 10 s) for `duration` ms in a row is stopped before the computer suffers
 * with it. The biggest of those first, one at a time; the others start over,
 * since what weighed on them may be gone with it.
 */
export class PressureWatch<K> {
  private readonly since = new Map<K, number>()

  constructor(
    readonly limit = Number(process.env.BRIGADE_PREVIEW_PRESSURE) || 60,
    readonly duration = Number(process.env.BRIGADE_PREVIEW_PRESSURE_MS) || 30_000,
  ) {}

  /** One reading per preview that runs (not frozen). Returns the one to stop, if any. */
  observe(readings: { key: K; pressure: number; memory: number }[], now: number) {
    const stalled: typeof readings = []
    const seen = new Set<K>()
    for (const reading of readings) {
      seen.add(reading.key)
      if (reading.pressure < this.limit) {
        this.since.delete(reading.key)
        continue
      }
      const since = this.since.get(reading.key) ?? now
      this.since.set(reading.key, since)
      if (now - since >= this.duration) stalled.push(reading)
    }
    for (const key of this.since.keys()) if (!seen.has(key)) this.since.delete(key)
    if (stalled.length === 0) return undefined
    const victim = stalled.reduce((a, b) => (b.memory > a.memory ? b : a))
    this.since.delete(victim.key)
    for (const key of this.since.keys()) this.since.set(key, now)
    return victim.key
  }
}

/** One preview's cgroup. Its processes join it before the command runs. */
export class PreviewCgroup {
  constructor(readonly path: string) {}

  /** Move a process in: the preview's wrapper, before it starts the command. */
  async attach(pid: number) {
    await write(this.path, 'cgroup.procs', String(pid))
  }

  /** Kill every process in it at once, wherever they went (a dev server's children, setsid'd ones). */
  async kill() {
    await write(this.path, 'cgroup.kill', '1').catch(() => undefined)
  }

  /** Stop all its processes where they are: no CPU, no timers, until thawed. */
  async freeze() {
    await write(this.path, 'cgroup.freeze', '1')
    // Freezing is asynchronous: done when every task has stopped.
    for (let i = 0; i < 100 && !(await this.frozen()); i++) await sleep(10)
    await write(this.path, 'memory.swap.max', 'max')
  }

  async thaw() {
    // What it swapped out while frozen stays there until it needs it.
    await write(this.path, 'memory.swap.max', RUNNING_SWAP)
    await write(this.path, 'cgroup.freeze', '0')
  }

  async frozen() {
    return (await keyed(join(this.path, 'cgroup.events'), 'frozen')) === 1
  }

  /**
   * Give back what it holds: its page cache, and with swap its own memory,
   * written out compressed (zswap) or to the swap file. Returns the bytes freed.
   */
  async reclaim() {
    const before = await this.current()
    // It frees what it can and says EAGAIN when that is less than asked: not an error here.
    await write(this.path, 'memory.reclaim', String(before)).catch(() => undefined)
    return before - (await this.current())
  }

  async current() {
    return Number(await readFile(join(this.path, 'memory.current'), 'utf8').catch(() => 0))
  }

  /** Its OOM counts so far: see oomReason. */
  async ooms(): Promise<Ooms> {
    const events = join(this.path, 'memory.events')
    return {
      kills: await keyed(events, 'oom_kill'),
      atCeiling: await keyed(events, 'oom'),
      // previews/ itself: its own count only, not its children's.
      together: await keyed(join(dirname(this.path), 'memory.events.local'), 'oom'),
    }
  }

  /** The share of the last 10 s in which all its processes waited on memory, in %. */
  async pressure() {
    const text = await readFile(join(this.path, 'memory.pressure'), 'utf8').catch(() => '')
    return Number(/^full avg10=([\d.]+)/m.exec(text)?.[1] ?? 0)
  }

  /** Once its processes are gone. */
  async remove() {
    for (let i = 0; i < 20; i++) {
      try {
        await rmdir(this.path)
        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        await this.kill()
        await sleep(100)
      }
    }
  }
}

/** The previews' subtree of the runner's delegated cgroup, or null where there is none. */
export class PreviewCgroups {
  private constructor(
    private readonly root: string,
    readonly budget: ReturnType<typeof previewBudget>,
  ) {}

  static async open(): Promise<PreviewCgroups | null> {
    if (process.platform !== 'linux' || process.env.BRIGADE_PREVIEW_CGROUPS === '0') return null
    try {
      const self = (await readFile('/proc/self/cgroup', 'utf8'))
        .split('\n')
        .find((line) => line.startsWith('0::'))
        ?.slice(3)
        .trim()
      // systemd started the runner in its delegated subgroup: the service's cgroup is ours.
      if (!self || basename(self) !== 'runner') return null
      const service = join(ROOT, dirname(self))
      await access(join(service, 'cgroup.procs'), constants.W_OK)
      const root = join(service, 'previews')
      await mkdir(root, { recursive: true })
      // Its children get memory and CPU control only once the service's own cgroup hands them down.
      if (!(await enable(service)).includes('memory')) return null
      await enable(root)
      const budget = previewBudget()
      await write(root, 'memory.high', round(budget.high))
      await write(root, 'memory.max', round(budget.max))
      // Under contention, turns and the runner get about three quarters of the CPU.
      await write(root, 'cpu.weight', '30')
      const cgroups = new PreviewCgroups(root, budget)
      await cgroups.sweep()
      return cgroups
    } catch (error) {
      console.warn(`previews run without cgroups: ${String(error)}`)
      return null
    }
  }

  /** A cgroup for one run of a thread's preview, its restarts included. */
  async create(name: string) {
    const { each } = this.budget
    const cgroup = new PreviewCgroup(join(this.root, name.replace(/[^A-Za-z0-9_-]/g, '_')))
    await mkdir(cgroup.path, { recursive: true })
    await cgroup.thaw()
    // At its ceiling (and its swap's) the whole preview goes, not one of its processes. No
    // memory.high of its own: one that runs away would crawl there for many minutes, broken,
    // filling the swap; previews/ slows them down together, the idle ones reclaimed first.
    await write(cgroup.path, 'memory.max', round(each))
    await write(cgroup.path, 'memory.oom.group', '1')
    await write(cgroup.path, 'pids.max', '4096')
    return cgroup
  }

  /** Previews' cgroups a previous run of the runner left behind, empty: removed. */
  private async sweep() {
    for (const name of await readdir(this.root, { withFileTypes: true })) {
      if (name.isDirectory()) await rmdir(join(this.root, name.name)).catch(() => undefined)
    }
  }
}
