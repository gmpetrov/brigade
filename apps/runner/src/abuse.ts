// Abuse of a cloud computer by its teammates' processes (docs/abuse.md), told to Brigade's
// operators through the API (the abuse: alert), never to members:
//  - what the egress limits stopped (the setup's brigade-egress, read through the teammate
//    helper's egress-counts): mail sent straight to mail servers, the cloud's metadata, bursts
//    of new connections (a scan), a mining pool's protocol;
//  - miners among teammates' processes, by their command line, killed at once (the helper's
//    stop-process);
//  - a teammate whose processes keep most of the computer's CPU for a long stretch: only told,
//    since a long build does too.
import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { promisify } from 'node:util'
import type { RunnerToApi } from '@brigade/contracts'

const run = promisify(execFile)
const HELPER = '/usr/local/sbin/brigade-teammate'

/** How often processes and counters are read. */
export const ABUSE_EVERY_MS = 2 * 60_000
/** A teammate's processes using this share of all the computer's cores… */
export const CPU_SHARE = 0.8
/** …this long without a break: told. */
export const CPU_MINUTES = 30
/** Kernel ticks a second, for /proc/<pid>/stat's times (USER_HZ: 100 on Linux). */
const TICKS = 100

export type AbuseReport = Extract<RunnerToApi, { type: 'abuse' }>
type Blocked = AbuseReport['blocked']

/**
 * Known miners by their program's name, and what only a miner passes: a pool's address
 * (stratum+tcp://, stratum+ssl://, stratum2+tcp://) or XMRig's donation option.
 */
const MINER_NAMES =
  /^(xmrig|xmr-stak(-rx)?|cpuminer(-\w+)?|minerd|ccminer|nbminer|t-rex|lolminer|phoenixminer|ethminer|nanominer|srbminer(-multi)?|teamredminer|gminer|cgminer|bfgminer|nheqminer|bminer)$/i
const MINER_ARGS = /stratum\d?\+(tcp|ssl|tls):\/\/|--donate-level\b|--coin[= ](monero|xmr)\b/i

/** Whether a process is a miner, by its name (comm) and its arguments (NUL-separated). */
export function isMiner(comm: string, cmdline: string) {
  const args = cmdline.split('\0').filter(Boolean)
  const program = (args[0] ?? '').split('/').pop() ?? ''
  return MINER_NAMES.test(comm) || MINER_NAMES.test(program) || MINER_ARGS.test(args.join(' '))
}

/** brigade-egress's counts: "<rule> <packets>" lines. Unknown rules are left out. */
export function parseCounts(text: string): Blocked {
  const counts: Blocked = { smtp: 0, metadata: 0, scan: 0, mining: 0 }
  for (const line of text.split('\n')) {
    const [rule, packets] = line.trim().split(/\s+/)
    if (rule && rule in counts && /^\d+$/.test(packets ?? ''))
      counts[rule as keyof Blocked] = Number(packets)
  }
  return counts
}

/**
 * What was stopped since the last read. The first read is only where counting starts: what came
 * before the runner started was told by the runner before it, or a restart would tell it again.
 * Counters start again from 0 when the rules are set again (a boot, a setup): a counter lower
 * than before counts from 0.
 */
export function blockedSince(before: Blocked | null, now: Blocked): Blocked {
  if (!before) return { smtp: 0, metadata: 0, scan: 0, mining: 0 }
  const since = { ...now }
  for (const key of Object.keys(now) as (keyof Blocked)[])
    if (now[key] >= before[key]) since[key] = now[key] - before[key]
  return since
}

/** A teammate's users: its own uid and its subordinate ones (/etc/subuid), by name. */
export type Owners = {
  uids: Map<number, string>
  ranges: { user: string; start: number; count: number }[]
}

/** Teammates' users from /etc/passwd and /etc/subuid (bt-…). */
export function parseOwners(passwd: string, subuid: string): Owners {
  const uids = new Map<number, string>()
  for (const line of passwd.split('\n')) {
    const [user, , uid] = line.split(':')
    if (user?.startsWith('bt-') && uid && /^\d+$/.test(uid)) uids.set(Number(uid), user)
  }
  const ranges: Owners['ranges'] = []
  for (const line of subuid.split('\n')) {
    const [user, start, count] = line.split(':')
    if (user?.startsWith('bt-') && /^\d+$/.test(start ?? '') && /^\d+$/.test(count ?? ''))
      ranges.push({ user, start: Number(start), count: Number(count) })
  }
  return { uids, ranges }
}

export const ownerOf = (owners: Owners, uid: number) =>
  owners.uids.get(uid) ?? owners.ranges.find((r) => uid >= r.start && uid < r.start + r.count)?.user

/** A process as /proc says: its owner's uid, name, arguments and CPU ticks so far. */
export type Proc = { pid: number; uid: number; comm: string; cmdline: string; ticks: number }

/** utime + stime from /proc/<pid>/stat, after the name in parentheses (which may hold spaces). */
export function ticksOf(stat: string) {
  const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  // Fields 14 and 15 of stat; rest starts at field 3.
  return Number(rest[11]) + Number(rest[12])
}

async function readProcs(): Promise<Proc[]> {
  const procs: Proc[] = []
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const [status, cmdline, stat] = await Promise.all([
        readFile(`/proc/${name}/status`, 'utf8'),
        readFile(`/proc/${name}/cmdline`, 'utf8'),
        readFile(`/proc/${name}/stat`, 'utf8'),
      ])
      const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1])
      const comm = /^Name:\s+(.*)$/m.exec(status)?.[1] ?? ''
      procs.push({ pid: Number(name), uid, comm, cmdline, ticks: ticksOf(stat) })
    } catch {
      // Gone meanwhile.
    }
  }
  return procs
}

/**
 * Each teammate's share of all cores since the last sample, and since when it stays above
 * CPU_SHARE. A process seen for the first time counts from its next sample.
 */
export class CpuWatch {
  private ticks = new Map<number, number>()
  private at: number | null = null
  private above = new Map<string, number>()

  constructor(private readonly cores = availableParallelism()) {}

  /** Teammates above CPU_SHARE for CPU_MINUTES or more: their share now and for how long. */
  sample(procs: { pid: number; user: string; ticks: number }[], now: number) {
    const used = new Map<string, number>()
    const ticks = new Map<number, number>()
    for (const p of procs) {
      ticks.set(p.pid, p.ticks)
      const was = this.ticks.get(p.pid)
      if (was !== undefined && p.ticks >= was)
        used.set(p.user, (used.get(p.user) ?? 0) + p.ticks - was)
    }
    const elapsed = this.at === null ? 0 : (now - this.at) / 1000
    this.ticks = ticks
    this.at = now
    if (!elapsed) return []
    const long: { user: string; share: number; minutes: number }[] = []
    const over = new Set<string>()
    for (const [user, t] of used) {
      const share = t / TICKS / elapsed / this.cores
      if (share < CPU_SHARE) continue
      over.add(user)
      const since = this.above.get(user) ?? now - elapsed * 1000
      this.above.set(user, since)
      const minutes = Math.round((now - since) / 60_000)
      if (minutes >= CPU_MINUTES) long.push({ user, share: Math.round(share * 100) / 100, minutes })
    }
    for (const user of this.above.keys()) if (!over.has(user)) this.above.delete(user)
    return long
  }
}

type Deps = {
  counts?: () => Promise<string>
  procs?: () => Promise<Proc[]>
  owners?: () => Promise<Owners>
  stop?: (user: string, pid: number) => Promise<void>
  cpu?: CpuWatch
}

const helperOut = async (...args: string[]) =>
  (await run('sudo', ['-n', HELPER, ...args], { cwd: '/', timeout: 30_000 })).stdout

/** One look: what to report, if anything. */
export async function lookForAbuse(
  deps: Deps,
  state: { counts: Blocked | null },
  now = Date.now(),
): Promise<AbuseReport | null> {
  const counts = deps.counts ?? (() => helperOut('egress-counts'))
  const procs = deps.procs ?? readProcs
  const owners =
    deps.owners ??
    (async () =>
      parseOwners(
        await readFile('/etc/passwd', 'utf8'),
        await readFile('/etc/subuid', 'utf8').catch(() => ''),
      ))
  const stop =
    deps.stop ?? ((user, pid) => helperOut('stop-process', user, String(pid)).then(() => {}))

  // An older setup has no counters (an empty answer) or an older helper (an error): nothing.
  const read = await counts().then(parseCounts, () => null)
  const blocked = read
    ? blockedSince(state.counts, read)
    : { smtp: 0, metadata: 0, scan: 0, mining: 0 }
  if (read) state.counts = read

  const who = await owners()
  const theirs: (Proc & { user: string })[] = []
  for (const p of await procs()) {
    const user = ownerOf(who, p.uid)
    if (user) theirs.push({ ...p, user })
  }
  const miners: AbuseReport['miners'] = []
  for (const p of theirs) {
    if (!isMiner(p.comm, p.cmdline)) continue
    const command = p.cmdline.split('\0').filter(Boolean).join(' ').slice(0, 300) || p.comm
    const killed = await stop(p.user, p.pid).then(
      () => true,
      (error: unknown) => (
        console.warn(`could not stop miner ${p.pid} of ${p.user}: ${String(error)}`),
        false
      ),
    )
    miners.push({ user: p.user, pid: p.pid, command, killed })
  }
  const cpu = deps.cpu?.sample(theirs, now) ?? []

  const any = Object.values(blocked).some((n) => n > 0) || miners.length > 0 || cpu.length > 0
  return any ? { type: 'abuse', blocked, miners: miners.slice(0, 50), cpu: cpu.slice(0, 50) } : null
}

/** Looks every ABUSE_EVERY_MS, from now on, and reports what it finds. */
export function watchAbuse(report: (report: AbuseReport) => void) {
  const state = { counts: null as Blocked | null }
  const deps: Deps = { cpu: new CpuWatch() }
  let busy = false
  const look = async () => {
    if (busy) return
    busy = true
    try {
      const found = await lookForAbuse(deps, state)
      if (found) {
        console.warn(`abuse on this computer: ${JSON.stringify(found)}`)
        report(found)
      }
    } catch (error) {
      console.warn(`could not look for abuse: ${String(error)}`)
    } finally {
      busy = false
    }
  }
  void look()
  setInterval(() => void look(), ABUSE_EVERY_MS).unref()
}
