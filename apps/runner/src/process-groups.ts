// Turns and previews run in process groups of their own (detached), so the
// runner can stop each as one. A runner that dies without stopping them (killed,
// crashed, quit from Activity Monitor) leaves them running for good: harness
// bridges holding memory, previews holding their ports, where a preview started
// again may take the old one's answer for its own. So each group is noted in a
// file as it starts, and the next runner stops what is left of those, with what
// they started that is still their child (a harness runs commands in groups of
// their own). A cloud computer needs none of it: systemd stops all the runner's
// service holds (its cgroup) when the runner stops.
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { uptime } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { CLOUD, paths } from './config.js'

/** A group the runner started: its leader's pid, when, and what for (for the log). */
export type Group = { pgid: number; at: number; what: string }

/** A process as ps shows it; `started` in ms since the epoch, to the second. */
export type Proc = { pid: number; ppid: number; pgid: number; started: number }

type Saved = { boot: number; groups: Group[] }

/** ps gives start times to the second, and a group is noted just after its leader started. */
const SLACK_MS = 5_000
/** How long the processes left get to stop before they are killed. */
const GRACE_MS = 5_000

const execFileAsync = promisify(execFile)

export class ProcessGroups {
  private groups: Group[] = []
  private timer: NodeJS.Timeout | undefined

  constructor(
    private readonly file: string,
    private readonly enabled = true,
  ) {}

  /** Note a group the runner just started, by its leader's pid. */
  add(pgid: number | undefined, what: string) {
    if (!this.enabled || !pgid) return
    this.groups = [...this.groups.filter((g) => alive(g.pgid)), { pgid, at: Date.now(), what }]
    this.save()
    this.timer ??= setInterval(() => this.prune(), 60_000)
    this.timer.unref()
  }

  /** Forget the groups no process is left in. */
  prune() {
    const left = this.groups.filter((g) => alive(g.pgid))
    if (left.length === this.groups.length) return
    this.groups = left
    this.save()
  }

  /**
   * Stop what is left of the groups the runner before this one noted, but those it handed
   * over (`kept`, hand-over.ts), which go on this one's list; then start that list. Resolves
   * to what was stopped, for the log.
   */
  async reap(kept: ReadonlySet<number> = new Set()): Promise<string | undefined> {
    if (!this.enabled) return undefined
    let saved: Partial<Saved> | undefined
    try {
      saved = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Saved>
    } catch {
      // None yet.
    }
    // From before the computer last started: none of it can be left, and the pids are others' now.
    const fresh = Math.abs((saved?.boot ?? 0) - bootTime()) <= 60_000
    const all = fresh ? (saved?.groups ?? []) : []
    this.groups = all.filter((g) => kept.has(g.pgid))
    this.save()
    const groups = all.filter((g) => !kept.has(g.pgid))
    if (groups.length === 0) return undefined
    const found = leftovers(groups, await processes(), process.pid)
    if (found.length === 0) return undefined
    const signal = (pid: number, name: NodeJS.Signals | 0) => {
      try {
        process.kill(pid, name)
        return true
      } catch {
        return false
      }
    }
    for (const p of found) signal(p.pid, 'SIGTERM')
    // A paused preview's (previews.ts) only gets to its SIGTERM handler once resumed.
    for (const p of found) signal(p.pid, 'SIGCONT')
    const until = Date.now() + GRACE_MS
    while (Date.now() < until && found.some((p) => signal(p.pid, 0)))
      await new Promise((done) => setTimeout(done, 200))
    for (const p of found) if (signal(p.pid, 0)) signal(p.pid, 'SIGKILL')
    const what = new Set(found.map((p) => groups.find((g) => g.pgid === p.pgid)?.what))
    what.delete(undefined)
    return `${found.length} process(es) of ${[...what].join(', ') || 'its turns and previews'}`
  }

  private save() {
    const temp = `${this.file}.${process.pid}.tmp`
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
      writeFileSync(temp, JSON.stringify({ boot: bootTime(), groups: this.groups } satisfies Saved))
      renameSync(temp, this.file)
    } catch (error) {
      console.warn(`could not note the runner's process groups: ${String(error)}`)
    }
  }
}

/**
 * The processes to stop among those running: what is left of the groups, the
 * groups' pids being someone else's by now aside, and their children's
 * children. Never `self` (the runner) nor what started it.
 */
export function leftovers(groups: Group[], procs: Proc[], self: number): Proc[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  const spared = new Set<number>([1])
  for (let p = byPid.get(self); p && !spared.has(p.pid); p = byPid.get(p.ppid)) spared.add(p.pid)
  const found = new Map<number, Proc>()
  for (const group of groups) {
    const members = procs.filter((p) => p.pgid === group.pgid)
    const leader = members.find((p) => p.pid === group.pgid)
    // A pid is not given out again while its group lives; once it ended, another group may have it.
    // Its leader started when ours did; gone, everything left in it started after.
    const ours = leader
      ? Math.abs(leader.started - group.at) <= SLACK_MS
      : members.every((p) => p.started >= group.at - SLACK_MS)
    if (ours) for (const p of members) found.set(p.pid, p)
  }
  for (let grew = true; grew;) {
    grew = false
    for (const p of procs)
      if (!found.has(p.pid) && found.has(p.ppid)) {
        found.set(p.pid, p)
        grew = true
      }
  }
  return [...found.values()].filter((p) => !spared.has(p.pid))
}

/** The runner's own, on a member's machine. */
export const processGroups = new ProcessGroups(join(paths.state, 'process-groups.json'), !CLOUD)

/** Every process, from ps (the same options on macOS and Linux). */
export async function processes(now = Date.now()): Promise<Proc[]> {
  const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,etime='], {
    maxBuffer: 16 * 1024 * 1024,
  })
  return parseProcesses(stdout, now)
}

export function parseProcesses(text: string, now: number): Proc[] {
  const procs: Proc[] = []
  for (const line of text.split('\n')) {
    const [pid, ppid, pgid, etime] = line.trim().split(/\s+/)
    const elapsed = etime && /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(etime)
    if (!elapsed) continue
    const [, days = '0', hours = '0', minutes, seconds] = elapsed
    const ms =
      (((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000
    procs.push({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), started: now - ms })
  }
  return procs
}

/** When the computer last started, in ms since the epoch. */
const bootTime = () => Date.now() - uptime() * 1000

/** Whether any process is left in the group. */
function alive(pgid: number) {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
