// What else fills a cloud computer's disk, beside thread folders (folders.ts):
// the caches teammates' tools keep in their homes, and a reserve that keeps a
// little room for the runner when everything else is full.
//
// The caches go first, before any thread loses a file: a later install fetches
// again what it needs. pnpm's store matters most. A project's node_modules are
// hard links into it, so removing them (trimming a thread) frees nothing until
// the store is pruned; and every version of every package ever installed stays
// there otherwise.
import { rm, stat, statfs } from 'node:fs/promises'
import { uptime } from 'node:os'
import { join } from 'node:path'
import { run } from './repos.js'
import { teammateHome } from './teammates.js'

/**
 * How full the disk is (statfs: 1 - bavail / blocks, ext4's reserve counted as used) past
 * which boat no longer resumes a stopped computer on a machine of its size: measured on
 * Nov 4, a small or default machine's disk holds 84.2 GB, and boat refused a resume at
 * 78.7 GB used ("largest budget: 76.0 GB"). A computer stopped past it stays down. Its
 * snapshots fail past 95%.
 */
export const RESUME_LIMIT = 0.9
/**
 * Past this, the reserve goes and caches are cleared even while their teammate works: well
 * before RESUME_LIMIT, which an install crosses in a minute.
 */
export const CRITICAL = 0.85
/** Room is set aside only while the disk stays under this full with it: well below CRITICAL. */
const RESERVE_UNDER = 0.8
/** At most this much set aside… */
const RESERVE_MAX = 2 * 1024 ** 3
/** …and at most this share of the disk. */
const RESERVE_SHARE = 0.03
/** pnpm reads its whole store to prune it: once in a while, unless something was trimmed. */
export const CACHES_EVERY_MS = 30 * 60_000
const PRUNE_TIMEOUT_MS = 15 * 60_000
/**
 * Caches under the home that tools fill again by themselves. ~/.npm/_npx is not one: MCP
 * servers run from it (tidyHome removes the packages no longer run); nor ~/.cargo/bin, the tools cargo installed. Bun links a project's
 * node_modules from its cache like pnpm: they keep their files. Nor ~/.cache/ms-playwright:
 * Playwright downloads a browser only when told to (playwright install), and removes on its
 * own those no install of it uses. pnpm dlx's packages (~/.cache/pnpm/dlx) go with the
 * store's prune, a day after they were last fetched.
 */
const TOOL_CACHES = [
  '.npm/_cacache',
  '.cache/yarn',
  '.cache/pip',
  '.cache/go-build',
  '.bun/install/cache',
  '.cargo/registry/cache',
  '.cargo/registry/src',
  '.cargo/git/checkouts',
  '.cargo/git/db',
]
/**
 * Go's modules, and the Go toolchains a go.mod asked for (go clean -modcache): go fetches
 * them again as it builds. Go makes their folders read-only, which rm alone cannot remove.
 */
const GO_MODULES = 'go/pkg/mod'
/**
 * The site Mintlify's CLI downloads to preview docs (mint dev), a copy for each port it served
 * on and one more for its other commands, about 250 MB each: it downloads it again when it is
 * missing. Not while a mint command runs, which serves the site from there.
 */
const MINTLIFY_SITES = '.mintlify/previews'

/**
 * After everything was freed, still this full: Brigade's operators must act (the disk report
 * keeps it on the computer, for their disk: alert). Below FULL again, it is over.
 */
export const STILL_FULL = 0.8

/** A full disk's report names the largest entries of teammates' homes: at most this many… */
export const LARGEST_COUNT = 8
/** …none smaller than this. */
export const LARGEST_MIN = 256 * 1024 ** 2
const MEASURE_TIMEOUT_MS = 2 * 60_000
/**
 * Run as the teammate, in its home ($1): the size of each of its entries, hidden ones too, as
 * du says it ("bytes<TAB>./name"). What it cannot read is left out, not a failure.
 */
const MEASURE_SCRIPT =
  'cd -- "$1" 2>/dev/null || exit 0; ' +
  'find . -mindepth 1 -maxdepth 1 -print0 | xargs -0 -r du -xs --block-size=1 -- 2>/dev/null; exit 0'

export type Entry = { path: string; bytes: number }

/** du's lines (MEASURE_SCRIPT) as paths under the home. */
export function homeEntries(out: string, home: string): Entry[] {
  return out.split('\n').flatMap((line) => {
    const match = /^(\d+)\t\.\/(.+)$/.exec(line)
    return match ? [{ path: `${home}/${match[2]}`, bytes: Number(match[1]) }] : []
  })
}

/** The largest entries, largest first: at most `count`, none under `min`. */
export const largest = (entries: Entry[], count = LARGEST_COUNT, min = LARGEST_MIN) =>
  entries
    .filter((entry) => entry.bytes >= min)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, count)

/**
 * What takes room in teammates' homes, by entry: their thread folders together (threads), their
 * tools' state and caches, and whatever a teammate left elsewhere, which nothing frees on its own
 * (the thread folders are a cache, folders.ts; the rest of a home is not, as a teammate's cron
 * jobs, services and tools may run from it). For Brigade's operators, once the disk stays full.
 * Tests give where a user's home is (`homeOf`), and how many and how small (largest).
 */
export async function largestInHomes(
  users: (string | undefined)[],
  {
    homeOf = (runAs: string | undefined) => teammateHome(runAs ?? ''),
    count = LARGEST_COUNT,
    min = LARGEST_MIN,
  } = {},
) {
  const entries: Entry[] = []
  for (const runAs of users) {
    const home = homeOf(runAs)
    const out = await run('sh', ['-c', MEASURE_SCRIPT, 'sh', home], {
      runAs,
      timeout: MEASURE_TIMEOUT_MS,
    }).catch((error) => {
      console.warn(`could not measure ${runAs ?? home}'s home: ${String(error)}`)
      return Buffer.alloc(0)
    })
    entries.push(...homeEntries(out.toString(), home))
  }
  return largest(entries, count, min)
}

/**
 * Where boat's lazy restore keeps its state, readable by every user. A resumed computer runs
 * before its disk is all there: boat copies the snapshot back in the background (it writes
 * `mounted` once the computer boots, `hydration-done` once every file is back). Until then, a
 * file removed is only noted (a tombstone) and leaves the disk at the end of the restore, while
 * what is written goes to the disk at once. Measured on Nov 5: the disk read 88% full 16 minutes
 * after a resume, the runner opened the disk_full ticket, and it closed 6 seconds after boat
 * said the restore was done, nothing else having changed.
 */
export const RESTORE_DIR = '/var/lib/ascii-lazy'
/** A restore said to run longer than this is taken as over: the API stops waiting for one then too. */
export const RESTORE_MAX_MS = 3 * 60 * 60_000

/**
 * Whether boat is still restoring this computer's disk since it last booted: `mounted` written
 * since the boot, and no `hydration-done` since. Neither file (not boat, or an older one), one
 * from an earlier boot, or one older than RESTORE_MAX_MS: not restoring.
 */
export async function restoring(
  dir = RESTORE_DIR,
  now = Date.now(),
  bootedAt = now - uptime() * 1000,
) {
  const [mounted, done] = await Promise.all(
    ['mounted', 'hydration-done'].map((name) => stat(join(dir, name)).catch(() => null)),
  )
  // A minute's slack: the boot time is read from the uptime, to the second.
  if (!mounted || mounted.mtimeMs < bootedAt - 60_000) return false
  if (now - mounted.mtimeMs >= RESTORE_MAX_MS) return false
  return !done || done.mtimeMs < mounted.mtimeMs
}

/** Package managers whose runs write into the caches cleared here, by the name their command has. */
const MANAGERS = new Set([
  'pnpm',
  'npm',
  'npm-cli',
  'yarn',
  'bun',
  'pip',
  'uv',
  'corepack',
  'go',
  'cargo',
])
/** Their commands that install, and so write into a cache or store while they run. */
const INSTALLS = new Set([
  'install',
  'i',
  'ci',
  'add',
  'update',
  'up',
  'upgrade',
  'remove',
  'rm',
  'uninstall',
  'un',
  'dlx',
  'fetch',
  'import',
  'rebuild',
  'dedupe',
  'store',
  'sync',
  'prepare',
])
/** For Go and Cargo, the commands that build: they read and write their caches as they run. */
const BUILDS: Record<string, Set<string>> = {
  go: new Set(['build', 'test', 'run', 'install', 'get', 'mod', 'vet', 'generate']),
  cargo: new Set([
    'build',
    'b',
    'check',
    'c',
    'test',
    't',
    'run',
    'r',
    'bench',
    'clippy',
    'doc',
    'fix',
    'fetch',
    'install',
    'update',
    'add',
    'vendor',
    'package',
    'publish',
    'metadata',
    'tree',
    'generate-lockfile',
  ]),
}

/** A command's manager: its file's name without .js or a version (pip3.12 is pip). */
const managerOf = (word: string) =>
  (word.split('/').at(-1) ?? '').replace(/\.(c|m)?js$/, '').replace(/^pip[\d.]*$/, 'pip')

/**
 * Whether a command line is a package manager installing. `pnpm` alone installs.
 * Any of the first words after the manager may name the install, as a flag's
 * value can come before it (pnpm --dir web install). Wrong only toward
 * "installing", which only puts off clearing a cache.
 */
export function installs(args: string) {
  const words = args.trim().split(/\s+/)
  const at = words.findIndex((word) => MANAGERS.has(managerOf(word)))
  if (at < 0) return false
  const manager = managerOf(words[at]!)
  const rest = words.slice(at + 1).filter((word) => !word.startsWith('-'))
  if (rest.length === 0) return ['pnpm', 'yarn', 'bun'].includes(manager)
  const commands = BUILDS[manager] ?? INSTALLS
  return rest.slice(0, 3).some((word) => commands.has(word))
}

/**
 * Whether a command line runs Mintlify's CLI: mint or mintlify by name (mint@4.2.1167 with
 * pnpm dlx), or the file node runs (…/node_modules/mint/index.js). Wrong only toward
 * "runs", which only keeps its site.
 */
export const runsMintlify = (args: string) =>
  args
    .trim()
    .split(/\s+/)
    .some((word) => /(^|\/)mint(lify)?(@[\w.-]+)?(\/index\.js)?$/.test(word))

/** The command lines of the teammate's processes; null when they could not be read. */
async function commandsOf(runAs: string) {
  // Every process, by uid: `ps -u` fails when the teammate has none. The runner reads every
  // user's command lines; none of them is the teammate's to hide.
  const read = await Promise.all([run('id', ['-u', runAs]), run('ps', ['-A', '-o', 'uid=,args='])])
    .then(([uid, out]) => ({ uid: uid.toString().trim(), lines: out.toString().split('\n') }))
    .catch(() => null)
  if (!read) return null
  return read.lines.flatMap((line) => {
    const [uid = '', ...args] = line.trim().split(/\s+/)
    return uid === read.uid ? [args.join(' ')] : []
  })
}

/** Whether one of the teammate's processes is installing packages: its caches stay until it is done. */
export async function installing(runAs: string) {
  const commands = await commandsOf(runAs)
  // Unknown: as if it were.
  return !commands || commands.some(installs)
}

/** How much to set aside on a disk of this size. */
export function reserveSize(diskBytes: number) {
  return Math.min(RESERVE_MAX, Math.floor(diskBytes * RESERVE_SHARE))
}

/** The pnpm stores other than the one pnpm uses now (v3 from pnpm 8, say): nothing installs into them again. */
export function oldStores(entries: string[], current: string) {
  return entries.filter((entry) => /^v\d+$/.test(entry) && entry !== current)
}

/**
 * Clear a teammate's tool caches: prune its pnpm store, remove the stores an
 * older pnpm left, the caches of npm, yarn, pip, Go and Cargo, Go's modules, and
 * Mintlify's site unless a mint command runs. Never its thread folders. `home` is
 * the teammate's home; runAs its user (none in tests).
 */
export async function freeCaches(
  home: string,
  runAs?: string,
  /** Reads the teammate's command lines (tests): from ps unless given; null when unknown. */
  readCommands: () => Promise<string[] | null> = async () => (runAs ? commandsOf(runAs) : []),
) {
  const before = await free(home)
  // From the home: pnpm writes a probe file where it runs, and the runner runs commands from /.
  const pnpm = (...args: string[]) =>
    run('sh', ['-c', 'cd "$HOME" && exec pnpm "$@"', 'pnpm', ...args], {
      runAs,
      env: { HOME: home },
      timeout: PRUNE_TIMEOUT_MS,
    })
  const storeRoot = join(home, '.local', 'share', 'pnpm', 'store')
  // The store pnpm uses now, as …/store/v10.
  const current = (await pnpm('store', 'path').catch(() => Buffer.alloc(0))).toString().trim()
  if (current.startsWith(`${storeRoot}/`)) {
    await pnpm('store', 'prune').then(
      // Its last line says how many packages went.
      (out) =>
        console.log(
          `pruned ${runAs ?? home}'s pnpm store: ${out.toString().trim().split('\n').at(-1)}`,
        ),
      (error) => console.warn(`could not prune ${runAs ?? home}'s pnpm store: ${String(error)}`),
    )
    // As the teammate: the runner cannot read its home.
    const versions = (await run('ls', ['-1', storeRoot], { runAs }).catch(() => Buffer.alloc(0)))
      .toString()
      .split('\n')
    for (const old of oldStores(versions, current.slice(storeRoot.length + 1)))
      // The node_modules made from it keep their files: they are hard links.
      await remove(join(storeRoot, old), runAs)
  }
  for (const cache of TOOL_CACHES) await remove(join(home, cache), runAs)
  await remove(join(home, GO_MODULES), runAs, true)
  // Read last, just before: a mint command started during the prune (up to PRUNE_TIMEOUT_MS)
  // keeps its site. Unknown: as if one ran.
  const commands = await readCommands()
  if (commands && !commands.some(runsMintlify)) await remove(join(home, MINTLIFY_SITES), runAs)
  const freed = (await free(home)) - before
  if (freed > 0) console.log(`cleared ${runAs ?? home}'s caches: ${gib(freed)} freed`)
  return freed
}

/**
 * Room set aside on the disk with the thread folders, given back when it is
 * nearly full (CRITICAL): the runner, its state and the turn under way have
 * room to finish while the rest is freed. Set aside again once there is room.
 * Counted as free space when deciding what to free (folders.ts), like the swap
 * file: it must never be why a thread loses its files.
 */
export class Reserve {
  /** Given back, and not set aside again since: the disk is still nearly full. */
  released = false

  constructor(
    private readonly file: string,
    /** A path on the disk to watch: the reserve is kept only on that disk. */
    private readonly disk: string,
  ) {}

  /** Set aside, when the disk stays under RESERVE_UNDER full with it. */
  async keep() {
    if ((await this.size()) > 0) return
    const [s, same] = await Promise.all([statfs(this.disk), this.onDisk()])
    if (!same) return
    const size = reserveSize(s.blocks * s.bsize)
    if (size <= 0 || 1 - (s.bavail * s.bsize - size) / (s.blocks * s.bsize) >= RESERVE_UNDER) return
    try {
      await run('fallocate', ['-l', String(size), this.file])
    } catch (error) {
      // Not left half made: it would look set aside.
      await rm(this.file, { force: true })
      return console.warn(`could not set room aside on the disk: ${String(error)}`)
    }
    this.released = false
    console.log(`set ${gib(size)} aside on the disk`)
  }

  /** Give it back. Whether there was one. */
  async release() {
    if ((await this.size()) === 0) return false
    await rm(this.file, { force: true })
    this.released = true
    console.warn('the disk is nearly full: gave back the room set aside')
    return true
  }

  /** The bytes it takes on the disk; 0 when there is none. */
  size() {
    return stat(this.file).then(
      (s) => s.blocks * 512,
      () => 0,
    )
  }

  private async onDisk() {
    const dir = this.file.slice(0, this.file.lastIndexOf('/')) || '/'
    const [a, b] = await Promise.all([stat(dir), stat(this.disk)]).catch(() => [])
    return Boolean(a && b && a.dev === b.dev)
  }
}

/** A harness's files for a session (its event log, start config): kept this long after its last write. */
export const RUNS_KEEP_MS = 3 * 24 * 60 * 60_000
/** A package npx installed: kept this long after it was last run. */
export const NPX_KEEP_MS = 14 * 24 * 60 * 60_000
/** How often a teammate's home is tidied (tidyHome), however empty the disk. */
export const TIDY_EVERY_MS = 6 * 60 * 60_000

/**
 * Run as the teammate, by the runner's Node: in its home, remove the harness's folders of
 * sessions untouched for RUNS_KEEP_MS (~/.ai-sdk-harness/.agent-runs: the adapters never
 * remove them, a few MB per turn), except those of threads in use; and the packages npx
 * installed and has not run for NPX_KEEP_MS (~/.npm/_npx), except those a process runs
 * from. npx installs one again when asked. Prints how many of each went.
 * Arguments: home, the threads in use (JSON), the npx folders processes run from (JSON), now.
 */
export const TIDY_SCRIPT = `
const { readdirSync, rmSync, statSync } = require('node:fs')
const { join } = require('node:path')
const [home, inUse, running, now] = process.argv.slice(1)
const keep = new Set(JSON.parse(inUse))
const busy = JSON.parse(running)
const time = (path, key) => { try { return statSync(path)[key] } catch { return 0 } }
const list = (dir) => { try { return readdirSync(dir) } catch { return [] } }
// The newest write in a folder, a few levels down.
const newest = (dir, depth) => {
  let last = time(dir, 'mtimeMs')
  if (depth > 0)
    for (const name of list(dir)) {
      const path = join(dir, name)
      last = Math.max(last, time(path, 'mtimeMs'), newest(path, depth - 1))
    }
  return last
}
let runs = 0
const runsDir = join(home, '.ai-sdk-harness', '.agent-runs')
for (const name of list(runsDir)) {
  if (keep.has(name) || [...keep].some((id) => name.startsWith(id + '-'))) continue
  const dir = join(runsDir, name)
  if (Number(now) - newest(dir, 3) < ${RUNS_KEEP_MS}) continue
  rmSync(dir, { recursive: true, force: true })
  runs++
}
let npx = 0
const npxDir = join(home, '.npm', '_npx')
for (const name of list(npxDir)) {
  const dir = join(npxDir, name)
  if (busy.some((path) => dir.endsWith(path))) continue
  // Running a package reads its manifest (atime: once a day at most on a relatime disk).
  const last = Math.max(
    time(dir, 'mtimeMs'),
    time(join(dir, 'package.json'), 'atimeMs'),
    time(join(dir, 'node_modules', '.package-lock.json'), 'atimeMs'),
  )
  if (Number(now) - last < ${NPX_KEEP_MS}) continue
  rmSync(dir, { recursive: true, force: true })
  npx++
}
process.stdout.write(JSON.stringify({ runs, npx }))
`

/** The npx folders that processes run from, as /.npm/_npx/<hash>, from `ps -A -o args=`. */
export const npxInUse = (commands: string) => [
  ...new Set([...commands.matchAll(/\/\.npm\/_npx\/[0-9a-f]+/g)].map((match) => match[0])),
]

/**
 * Tidy a teammate's home (TIDY_SCRIPT), however empty the disk: what the harness and npx
 * leave there grows by gigabytes a week otherwise. Not while it installs packages.
 */
export async function tidyHome(
  home: string,
  runAs: string | undefined,
  inUse: string[],
  now = Date.now(),
  /** Every process's command line (`ps -A -o args=`): read now unless given (tests). */
  processes?: string,
) {
  if (runAs && (await installing(runAs))) return null
  const commands =
    processes ?? (await run('ps', ['-A', '-o', 'args=']).catch(() => Buffer.alloc(0))).toString()
  const before = await free(home)
  const out = await run(
    process.execPath,
    [
      '-e',
      TIDY_SCRIPT,
      home,
      JSON.stringify(inUse),
      JSON.stringify(npxInUse(commands)),
      String(now),
    ],
    { runAs, timeout: PRUNE_TIMEOUT_MS },
  )
  const removed = JSON.parse(out.toString()) as { runs: number; npx: number }
  const freed = (await free(home)) - before
  if (removed.runs || removed.npx)
    console.log(
      `tidied ${runAs ?? home}'s home: ${removed.runs} old harness sessions, ${removed.npx} unused npx packages, ${gib(Math.max(0, freed))} freed`,
    )
  return removed
}

/** Remove a folder, as the teammate. `readOnly`: made writable first, as Go leaves its modules read-only. */
const remove = (path: string, runAs?: string, readOnly = false) =>
  (readOnly
    ? run(
        'sh',
        ['-c', '[ -e "$1" ] || exit 0; chmod -R u+w -- "$1"; exec rm -rf -- "$1"', 'sh', path],
        {
          runAs,
          timeout: PRUNE_TIMEOUT_MS,
        },
      )
    : run('rm', ['-rf', '--', path], { runAs })
  ).catch((error) => console.warn(`could not remove ${path}: ${String(error)}`))

async function free(path: string) {
  const s = await statfs(path).catch(() => null)
  return s ? s.bavail * s.bsize : 0
}

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`
