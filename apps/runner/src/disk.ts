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
import { join } from 'node:path'
import { run } from './repos.js'

/** Past this, the reserve goes and caches are cleared even while their teammate works. */
export const CRITICAL = 0.95
/** Room is set aside only while the disk stays under this full with it. */
const RESERVE_UNDER = 0.9
/** At most this much set aside… */
const RESERVE_MAX = 2 * 1024 ** 3
/** …and at most this share of the disk. */
const RESERVE_SHARE = 0.03
/** pnpm reads its whole store to prune it: once in a while, unless something was trimmed. */
export const CACHES_EVERY_MS = 30 * 60_000
const PRUNE_TIMEOUT_MS = 15 * 60_000
/** Caches under the home that tools fill again by themselves. ~/.npm/_npx is not one: MCP servers run from it. */
const TOOL_CACHES = ['.npm/_cacache', '.cache/yarn', '.cache/pip', '.cache/go-build']

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
 * older pnpm left, and the caches of npm, yarn, pip and Go. Never its thread
 * folders. `home` is the teammate's home; runAs its user (none in tests).
 */
export async function freeCaches(home: string, runAs?: string) {
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

const remove = (path: string, runAs?: string) =>
  run('rm', ['-rf', '--', path], { runAs }).catch((error) =>
    console.warn(`could not remove ${path}: ${String(error)}`),
  )

async function free(path: string) {
  const s = await statfs(path).catch(() => null)
  return s ? s.bavail * s.bsize : 0
}

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`
