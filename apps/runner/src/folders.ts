// Thread folders on a cloud computer are a cache. Threads never end, so their
// folders cannot wait for one to. As the disk fills, the caches of teammates'
// tools go first (disk.ts), which loses nothing; then the threads quiet longest
// lose their dependency and build folders (node_modules, .next, dist…),
// which a reinstall or rebuild makes again. When it is full, their folders are
// archived to the API's bucket and removed, until there is room again. The
// archive keeps what the teammate made (checkouts with their .git, uncommitted
// and untracked work, notes, screenshots) and leaves out what can be made
// again: folders git ignores (dependencies, build output, local databases) and
// node_modules anywhere. Whatever next needs the folder (a turn, a preview, a
// takeover, a file read) puts it back first. Quiet threads also lose, however
// empty the disk, node_modules folders a pnpm before 10 made in projects that
// now ask for pnpm 10 or later: installing over them would keep their copied
// packages. Either way, the teammate's next turn is told to reinstall what it
// needs.
//
// A member's machine is theirs: nothing is archived away from it, and no share
// of its disk is Brigade's to fill. There a thread quiet for days loses its
// dependency and build folders whatever the disk, and one quiet for hours once
// the disk runs short; the teammate is told the same way. Its preview's archive
// script runs first, and its Compose project's containers and volumes go too.
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { finished } from 'node:stream/promises'
import { randomUUID } from 'node:crypto'
import type { GitAccess } from '@brigade/contracts'
import { CLOUD, HOME } from './config.js'
import { prune, removeFor, removeMemberProject, stopQuiet } from './containers.js'
import { CACHES_EVERY_MS, CRITICAL, freeCaches, Reserve } from './disk.js'
import { COPIED } from './repo-settings.js'
import { owners, repairCaches, run } from './repos.js'
import { teammateHome } from './teammates.js'
import { threadFolder } from './threads.js'

/** Remove dependency and build folders of quiet threads once the disk is this full (space or inodes)… */
const TRIM_AT = 0.6
/** …until it is down to this. */
const TRIM_TO = 0.5
/** A thread active more recently than this keeps its dependencies until the disk is full. */
const TRIM_QUIET_MS = 3 * 60 * 60_000
/** Folders git ignores that a reinstall or rebuild makes again. Others (local databases, say) stay. */
const REGENERABLE = new Set([
  'node_modules',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.output',
  '.turbo',
  '.vite',
  '.parcel-cache',
  '.angular',
  'dist',
  'build',
  'coverage',
  'target',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.gradle',
])
/** On a member's machine, a thread quiet this long loses its dependency and build folders, however empty the disk… */
const MEMBER_TRIM_QUIET_MS = 3 * 24 * 60 * 60_000
/** …and one quiet TRIM_QUIET_MS while less than this is free (a tenth of the disk, on a small one). */
const MEMBER_SHORT = 20 * 1024 ** 3
/** Archive folders once the disk is this full… */
const FULL = 0.8
/** …until it is down to this. */
const ENOUGH = 0.65
/**
 * The swap file the computer's setup makes for frozen previews (brigade-swap, in the API's
 * cloud-bootstrap.ts): space set aside, not files. No reason to trim thread folders, so
 * counted as free for that; counted as used once the disk is really full.
 */
const SWAP_FILE = '/brigade.swap'
/** A thread active more recently than this keeps its folder, however full the disk. */
const MIN_QUIET_MS = 60 * 60_000
const CHECK_EVERY_MS = 5 * 60_000
/** How often the disk is looked at between checks: an install fills gigabytes in a minute. One statfs. */
const WATCH_EVERY_MS = 20_000
/** Past FULL, checked this often rather than every CHECK_EVERY_MS. */
const FULL_CHECK_EVERY_MS = 60_000
/** Nearly full (CRITICAL), a teammate's caches are cleared again after this, even while it works. */
const CRITICAL_CACHES_EVERY_MS = 5 * 60_000
/** Larger than this, a folder stays; tried again after a day. One signed PUT to R2 takes up to 5 GiB. */
const ARCHIVE_MAX = 4 * 1024 ** 3
const TOO_LARGE_RETRY_MS = 24 * 60 * 60_000
/** A folder that could not be archived (the API unreachable, say) is tried again after this. */
const FAILED_RETRY_MS = 60 * 60_000
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/

const RESTORED =
  "Note from Brigade: this thread's folder was archived to free disk on this computer and has just been put back. " +
  'Your files, checkouts and uncommitted work are as you left them, but folders git ignores (dependencies, ' +
  'build output, local databases) and node_modules folders are gone, and so are the containers and Docker volumes ' +
  'this thread had: reinstall, rebuild or start again what you need before running anything.'
const TRIMMED =
  'Note from Brigade: to free disk on this computer while this thread was quiet, its dependency and build folders ' +
  '(node_modules, .next, dist and the like, where git ignores them) were removed. Your files, checkouts, ' +
  'uncommitted work and local databases are as you left them: reinstall or rebuild what you need before running anything.'
const MEMBER_TRIMMED =
  'Note from Brigade: to free this computer while this thread was quiet, its dependency and build folders ' +
  '(node_modules, .next, dist and the like, where git ignores them) were removed, and so were the containers and ' +
  "Docker volumes of this thread's Compose project, if it had any (its local databases among them). Your files, " +
  'checkouts and uncommitted work are as you left them: reinstall, rebuild or start again what you need before running anything.'
const UPGRADED =
  'Note from Brigade: while this thread was quiet, the node_modules folders an older pnpm made in its checkouts ' +
  'were removed: pnpm 10 installing over them would keep the copies of packages they hold. Your files, checkouts, ' +
  'uncommitted work and local databases are as you left them: install dependencies again before running anything.'
/** What a teammate is told about its folder when the thread moved to this computer (arrive). */
const MOVED = {
  restored: (from: string) =>
    `Note from Brigade: this thread moved to this computer from ${from}, and your folder came with it. ` +
    'Your files, checkouts and uncommitted work are as you left them, but folders git ignores (dependencies, ' +
    'build output, local databases) and node_modules folders did not come, nor the containers and Docker volumes ' +
    'the thread had: reinstall, rebuild or start again what you need before running anything. Paths outside this ' +
    'folder, such as the home directory, are not the same as before.',
  kept: (from: string) =>
    `Note from Brigade: this thread moved to this computer from ${from}, which could not hand your folder over. ` +
    'This folder holds what this computer had of the thread from an earlier time: it may be out of date. ' +
    'Work you had not pushed may be on GitHub, on your branch or its brigade/wip/ backup: check out a repository ' +
    'again (checkout_repository) to bring it up to date.',
  empty: (from: string) =>
    `Note from Brigade: this thread moved to this computer from ${from}, which could not hand your folder over, ` +
    'so it starts empty here. Check out the repositories you need again (checkout_repository): your branch, ' +
    'or its backup of the work you had not pushed, comes back with them.',
}
const STOPPED =
  'Note from Brigade: the containers this thread started were stopped while it was quiet, to free the computer. ' +
  'Their data is kept: start them again (docker compose up -d, say) if you need them.'

export type FolderName = { sessionId: string; teammateId: string }

/** The API no longer has the thread: it was deleted. */
export class ThreadGone extends Error {}

/** A thread folder, when last used, and its teammate's user on a cloud computer. */
type Candidate = { name: FolderName; workDir: string; runAs?: string; active: number }

/** Archives in the API's bucket, by thread and teammate, streamed from and to files. */
export type FolderArchives = {
  /** Upload the file; resolves once the API has checked the bucket holds all of it. */
  put: (name: FolderName, file: string, size: number) => Promise<void>
  /** Download into the file; false when there is no archive. */
  get: (name: FolderName, file: string) => Promise<boolean>
  delete: (name: FolderName) => Promise<void>
  /** Whether the thread was deleted (the API answers 410 Gone). */
  gone: (name: FolderName) => Promise<boolean>
}

type State = {
  /** When each folder was last used, by its path. */
  active: Record<string, number>
  /** Folders put back whose teammate has not been told yet, nor its caches fetched again. */
  restored: string[]
  /** Folders whose thread's containers were stopped, whose teammate has not been told yet. */
  stopped: string[]
  /** Folders whose dependency and build folders were removed, whose teammate has not been told yet. */
  trimmed: string[]
  /** When each folder was last trimmed: trimmed again only once used since. */
  trimmedAt: Record<string, number>
  /** Folders whose node_modules made by an older pnpm were removed, whose teammate has not been told yet. */
  upgraded: string[]
  /** When each folder was last checked for node_modules made by an older pnpm: checked again only once used since. */
  upgradedAt: Record<string, number>
  /** Folders that could not be archived, and when to try again. */
  retryAt: Record<string, number>
  /** When the thread last moved here, by folder: each arrival is taken in once. */
  arrived: Record<string, string>
  /** Folders of threads that moved here whose teammate has not been told yet: how it came, and from where. */
  moved: Record<string, { how: keyof typeof MOVED; from: string }>
}

const z = (output: Buffer) => output.toString().split('\0').filter(Boolean)

export class Folders {
  private state: State = {
    active: {},
    restored: [],
    stopped: [],
    trimmed: [],
    trimmedAt: {},
    upgraded: [],
    upgradedAt: {},
    retryAt: {},
    arrived: {},
    moved: {},
  }
  private loaded: Promise<void>
  /** Work on a folder (archiving it, putting it back), one at a time per folder. */
  private locks = new Map<string, Promise<unknown>>()
  private checking = false
  private checkedAt = 0
  /** When each teammate's caches were last cleared, by user. */
  private cachesAt = new Map<string, number>()
  private reserve: Reserve | undefined
  private saveTimer: NodeJS.Timeout | undefined

  constructor(
    private readonly options: {
      archives: FolderArchives
      /** The thread has a turn, a person in control, a parked-but-live session or a preview. */
      inUse: (sessionId: string) => boolean
      /**
       * Before a thread's containers go: its folder is archived or handed over, or trimmed on a
       * member's machine. Runs its preview's archive script, which frees what its setup made.
       */
      quiet?: (name: FolderName) => Promise<unknown>
      stateFile: string
      /** Where archives are written on their way to and from the bucket. */
      tempDir: string
      /** On a cloud computer, the file that sets room aside on the disk (disk.ts Reserve). */
      reserveFile?: string
    },
  ) {
    if (CLOUD && options.reserveFile) this.reserve = new Reserve(options.reserveFile, '/home')
    this.loaded = readFile(options.stateFile, 'utf8').then(
      (text) => {
        const saved = JSON.parse(text) as Partial<State>
        // Uses noted before it loaded are newer.
        this.state = {
          active: { ...saved.active, ...this.state.active },
          restored: saved.restored ?? [],
          stopped: saved.stopped ?? [],
          trimmed: saved.trimmed ?? [],
          trimmedAt: saved.trimmedAt ?? {},
          upgraded: saved.upgraded ?? [],
          upgradedAt: saved.upgradedAt ?? {},
          retryAt: saved.retryAt ?? {},
          arrived: { ...saved.arrived, ...this.state.arrived },
          moved: { ...saved.moved, ...this.state.moved },
        }
      },
      () => undefined,
    )
  }

  /** Check the disk now and then. */
  start() {
    // Left by a runner that stopped mid-way.
    if (CLOUD)
      void rm(this.options.tempDir, { recursive: true, force: true }).catch(() => undefined)
    const check = () =>
      void this.check().catch((error) => console.warn(`folder check failed: ${String(error)}`))
    setTimeout(check, 60_000).unref()
    setInterval(check, CHECK_EVERY_MS).unref()
    if (!CLOUD) return
    // Between checks: past FULL, check now; nearly full, give the reserve back first.
    setInterval(
      () =>
        void (async () => {
          if ((await usage()) >= CRITICAL) await this.reserve?.release()
          if ((await this.fullness()) >= FULL && Date.now() - this.checkedAt >= FULL_CHECK_EVERY_MS)
            check()
        })().catch((error) => console.warn(`disk watch failed: ${String(error)}`)),
      WATCH_EVERY_MS,
    ).unref()
  }

  /** The folder is in use now: archived last. */
  touch(name: FolderName) {
    this.state.active[threadFolder(name.teammateId, name.sessionId).workDir] = Date.now()
    this.save()
  }

  /**
   * The folder is on disk: put back from its archive when it was archived.
   * Throws when it could not be: working in an empty folder would lose it.
   */
  async ready(name: FolderName) {
    this.touch(name)
    if (!CLOUD) return
    const { workDir, runAs } = threadFolder(name.teammateId, name.sessionId)
    await this.exclusive(workDir, async () => {
      if (await exists(workDir, runAs)) return
      const file = await this.tempFile()
      try {
        if (!(await this.options.archives.get(name, file))) return
        await unpack(file, workDir, runAs)
      } finally {
        await rm(file, { force: true })
      }
      await this.loaded
      this.state.restored.push(workDir)
      this.state.active[workDir] = Date.now()
      this.save()
      console.log(`put back ${workDir}`)
      await this.options.archives
        .delete(name)
        .catch((error) =>
          console.warn(`could not delete the archive of ${workDir}: ${String(error)}`),
        )
    })
  }

  /**
   * The thread moved to this computer (ThreadSpec.moved): once per arrival,
   * its folder comes from the archive the computer it left made, in place of
   * whatever this computer had of it from before. With no archive (that
   * computer was offline), what is here stays. On any computer.
   */
  async arrive(name: FolderName, moved: { at: string; from: string }) {
    await this.loaded
    const { workDir, runAs } = threadFolder(name.teammateId, name.sessionId)
    if (this.state.arrived[workDir] === moved.at) return
    await this.exclusive(workDir, async () => {
      if (this.state.arrived[workDir] === moved.at) return
      const file = await this.tempFile()
      let restored = false
      try {
        if (await this.options.archives.get(name, file)) {
          // What was here is from before the thread left: its containers too.
          if (runAs) await removeFor(runAs, name.sessionId)
          await run('rm', ['-rf', '--', workDir], { runAs })
          await unpack(file, workDir, runAs)
          restored = true
        }
      } finally {
        await rm(file, { force: true })
      }
      const here = restored || (await exists(workDir, runAs))
      this.state.arrived[workDir] = moved.at
      this.state.moved[workDir] = {
        how: restored ? 'restored' : here ? 'kept' : 'empty',
        from: moved.from,
      }
      this.state.restored = this.state.restored.filter((dir) => dir !== workDir)
      this.state.active[workDir] = Date.now()
      this.save()
      console.log(
        `took in ${workDir}, moved from ${moved.from}${restored ? '' : ' without its files'}`,
      )
      if (restored)
        await this.options.archives
          .delete(name)
          .catch((error) =>
            console.warn(`could not delete the archive of ${workDir}: ${String(error)}`),
          )
    })
  }

  /**
   * The thread moves to another computer: its folder goes to the bucket for
   * that computer to put back (arrive). A cloud computer then removes it; a
   * member's machine keeps it, theirs to look at. Throws when it could not be
   * archived. A folder already archived to free disk is in the bucket as is.
   */
  async release(name: FolderName) {
    await this.loaded
    const { workDir, runAs } = threadFolder(name.teammateId, name.sessionId)
    await this.exclusive(workDir, async () => {
      if (!(await exists(workDir, runAs))) return
      await this.quiet(name)
      // Its containers first: one writing into the folder would change it while it is packed.
      if (runAs) await removeFor(runAs, name.sessionId)
      else if (!CLOUD) await removeMemberProject(name.sessionId)
      const file = await this.tempFile()
      try {
        const size = await pack(workDir, file, runAs)
        if (size === null) throw new Error(`larger than ${ARCHIVE_MAX} bytes without dependencies`)
        await this.options.archives.put(name, file, size)
      } finally {
        await rm(file, { force: true })
      }
      if (CLOUD) await run('rm', ['-rf', '--', workDir], { runAs })
      this.forget(workDir)
      console.log(`handed ${workDir} over to another computer`)
    })
  }

  /**
   * The thread was deleted: its folder and containers go, on a cloud computer,
   * where nothing else would ever remove them. A member's machine keeps the
   * folder, theirs to look at.
   */
  async removeThread(sessionId: string) {
    if (!CLOUD || !SAFE_ID.test(sessionId)) return
    await this.loaded
    for (const runAs of await owners()) {
      if (!runAs) continue
      // Teammate users are named after their teammate's id (teammateUser).
      const name = { sessionId, teammateId: runAs.slice('bt-'.length) }
      const { workDir } = threadFolder(name.teammateId, sessionId)
      await this.exclusive(workDir, () => this.removeNow(name, workDir, runAs))
    }
  }

  private async removeNow(name: FolderName, workDir: string, runAs?: string) {
    if (await exists(workDir, runAs)) {
      await this.quiet(name)
      if (runAs) await removeFor(runAs, name.sessionId)
      await run('rm', ['-rf', '--', workDir], { runAs })
      console.log(`removed ${workDir}: its thread was deleted`)
    }
    delete this.state.arrived[workDir]
    this.forget(workDir)
  }

  /** What was noted of a folder no longer here. */
  private forget(workDir: string) {
    delete this.state.active[workDir]
    delete this.state.retryAt[workDir]
    delete this.state.trimmedAt[workDir]
    delete this.state.upgradedAt[workDir]
    delete this.state.moved[workDir]
    for (const list of ['restored', 'stopped', 'trimmed', 'upgraded'] as const)
      this.state[list] = this.state[list].filter((dir) => dir !== workDir)
    this.save()
  }

  /**
   * For a teammate's turn: what to tell it about its folder brought from
   * another computer, put back or trimmed, its old node_modules removed, or
   * its containers stopped, once. A folder put back or brought over gets the
   * caches its checkouts borrow from fetched again.
   */
  async takeNote(name: FolderName, git: GitAccess | undefined) {
    await this.loaded
    const { workDir, runAs } = threadFolder(name.teammateId, name.sessionId)
    const moved = this.state.moved[workDir]
    if (moved) {
      if (moved.how === 'restored' && git) await repairCaches(workDir, git, runAs, true)
      delete this.state.moved[workDir]
      this.save()
      return MOVED[moved.how](moved.from)
    }
    const restored = this.state.restored.includes(workDir)
    const trimmed = this.state.trimmed.includes(workDir)
    const upgraded = this.state.upgraded.includes(workDir)
    const stopped = this.state.stopped.includes(workDir)
    if (!restored && !trimmed && !upgraded && !stopped) return undefined
    if (restored && git) await repairCaches(workDir, git, runAs)
    this.state.restored = this.state.restored.filter((dir) => dir !== workDir)
    this.state.trimmed = this.state.trimmed.filter((dir) => dir !== workDir)
    this.state.upgraded = this.state.upgraded.filter((dir) => dir !== workDir)
    this.state.stopped = this.state.stopped.filter((dir) => dir !== workDir)
    this.save()
    // Put back says it all, and trimmed says node_modules too.
    if (restored) return RESTORED
    return [trimmed ? (CLOUD ? TRIMMED : MEMBER_TRIMMED) : upgraded && UPGRADED, stopped && STOPPED]
      .filter(Boolean)
      .join('\n\n')
  }

  /**
   * Stop the containers of threads gone quiet, and remove the node_modules
   * an older pnpm made in them. As the disk fills, remove the
   * dependency and build folders of the threads quiet longest. When it is
   * full, prune what Docker keeps for nothing, then archive the folders of
   * the threads quiet longest until it is not.
   */
  async check() {
    if (this.checking) return
    this.checking = true
    let critical = false
    try {
      await this.loaded
      const now = Date.now()
      const candidates = await this.candidates()
      const quiet = (c: (typeof candidates)[number]) =>
        now - c.active >= MIN_QUIET_MS && !this.options.inUse(c.name.sessionId)
      if (!CLOUD) return await this.trimMine(candidates, quiet, now)
      for (const runAs of new Set(candidates.flatMap((c) => c.runAs ?? []))) {
        const mine = candidates.filter((c) => c.runAs === runAs)
        const stopped = await stopQuiet(
          runAs,
          mine.map((c) => c.name.sessionId),
          (sessionId) => mine.some((c) => c.name.sessionId === sessionId && quiet(c)),
          (sessionId) => !this.options.inUse(sessionId),
        ).catch((error) => {
          console.warn(`could not stop quiet containers for ${runAs}: ${String(error)}`)
          return []
        })
        for (const sessionId of stopped) {
          const workDir = mine.find((c) => c.name.sessionId === sessionId)!.workDir
          if (!this.state.stopped.includes(workDir)) this.state.stopped.push(workDir)
          this.save()
        }
      }

      for (const candidate of candidates) {
        if (now - candidate.active < TRIM_QUIET_MS) break
        if (!quiet(candidate)) continue
        if ((this.state.upgradedAt[candidate.workDir] ?? 0) >= candidate.active) continue
        await this.upgrade(candidate).catch((error) =>
          console.warn(
            `could not remove old node_modules in ${candidate.workDir}: ${String(error)}`,
          ),
        )
      }

      // Nearly full: caches are cleared even while their teammate works, and the reserve
      // stays given back.
      // Given back, it stays nearly full until there is room to set it aside again.
      critical = (await usage()) >= CRITICAL || this.reserve?.released === true
      const users = (await owners()).filter((runAs): runAs is string => Boolean(runAs))
      // The caches of teammates' tools first: clearing them loses nothing.
      if ((await this.fullness(true)) >= TRIM_AT)
        for (const runAs of users) await this.clearCaches(runAs, critical)

      const trimmedFor = new Set<string>()
      if ((await this.fullness(true)) >= TRIM_AT)
        for (const candidate of candidates) {
          if ((await this.fullness(true)) < TRIM_TO) break
          if (now - candidate.active < TRIM_QUIET_MS) break
          if (!quiet(candidate)) continue
          // Nothing new since it was last trimmed.
          if ((this.state.trimmedAt[candidate.workDir] ?? 0) >= candidate.active) continue
          const trimmed = await this.trim(candidate).catch((error) => {
            console.warn(`could not trim ${candidate.workDir}: ${String(error)}`)
            return false
          })
          if (trimmed && candidate.runAs) trimmedFor.add(candidate.runAs)
        }
      // What a trim removed from node_modules stays in pnpm's store until it is pruned.
      for (const runAs of trimmedFor) await this.clearCaches(runAs, critical, true)

      if ((await this.fullness()) < FULL) return
      for (const runAs of await owners())
        if (runAs)
          await prune(runAs).catch((error) =>
            console.warn(`could not prune ${runAs}'s Docker: ${String(error)}`),
          )
      for (const candidate of candidates) {
        if ((await this.fullness()) < ENOUGH) break
        if (now - candidate.active < MIN_QUIET_MS) break
        if (!quiet(candidate)) continue
        if (now < (this.state.retryAt[candidate.workDir] ?? 0)) continue
        await this.archive(candidate).catch((error) => {
          this.retry(candidate.workDir, FAILED_RETRY_MS)
          console.warn(`could not archive ${candidate.workDir}: ${String(error)}`)
        })
      }
      if ((await this.fullness()) >= FULL)
        console.warn('the disk is still full: every thread folder left is in use or too large')
    } finally {
      // Room again: set some aside for the next time it fills.
      if (!critical)
        await this.reserve
          ?.keep()
          .catch((error) => console.warn(`could not set room aside: ${String(error)}`))
      this.checkedAt = Date.now()
      this.checking = false
    }
  }

  /**
   * Clear a teammate's tool caches (disk.ts), once in a while (CACHES_EVERY_MS)
   * unless `again`. While one of its threads is in use, an install may be
   * under way: only when the disk is nearly full, and then more often.
   */
  private async clearCaches(runAs: string, critical: boolean, again = false) {
    // Its folders now, not when the check began: a thread may have started since.
    const busy = (await this.foldersOf(runAs)).some((c) => this.options.inUse(c.name.sessionId))
    if (busy && !critical) return
    const every = again ? 0 : critical ? CRITICAL_CACHES_EVERY_MS : CACHES_EVERY_MS
    if (Date.now() - (this.cachesAt.get(runAs) ?? 0) < every) return
    this.cachesAt.set(runAs, Date.now())
    await freeCaches(teammateHome(runAs), runAs).catch((error) =>
      console.warn(`could not clear ${runAs}'s caches: ${String(error)}`),
    )
  }

  /**
   * On a member's machine: remove the dependency and build folders of the
   * threads quiet for days, then of those quiet for hours while the disk is short.
   */
  private async trimMine(
    candidates: Candidate[],
    quiet: (candidate: Candidate) => boolean,
    now: number,
  ) {
    for (const candidate of candidates) {
      if (now - candidate.active < TRIM_QUIET_MS) break
      if (now - candidate.active < MEMBER_TRIM_QUIET_MS && !(await short())) break
      if (!quiet(candidate)) continue
      // Nothing new since it was last trimmed.
      if ((this.state.trimmedAt[candidate.workDir] ?? 0) >= candidate.active) continue
      await this.trim(candidate).catch((error) =>
        console.warn(`could not trim ${candidate.workDir}: ${String(error)}`),
      )
    }
  }

  /**
   * How full the disk is, for what to free: the reserve counted as free, and with
   * `swap` the swap file too (SWAP_FILE).
   */
  private async fullness(swap = false) {
    const [swapBytes, reserved] = await Promise.all([
      swap ? swapSize() : 0,
      this.reserve?.size() ?? 0,
    ])
    return usage(swapBytes + reserved)
  }

  /** Every thread folder on this computer, quiet longest first. */
  private async candidates() {
    if (!CLOUD) return this.memberCandidates()
    const found: Candidate[] = []
    for (const runAs of await owners()) if (runAs) found.push(...(await this.foldersOf(runAs)))
    return found.sort((a, b) => a.active - b.active)
  }

  /** A teammate's thread folders on a cloud computer. */
  private async foldersOf(runAs: string) {
    const found: Candidate[] = []
    const root = `${teammateHome(runAs)}/threads`
    const lines = (
      await run(
        'find',
        [root, '-mindepth', '1', '-maxdepth', '1', '-type', 'd', '-printf', '%T@ %f\\n'],
        { runAs },
      ).catch(() => Buffer.alloc(0))
    )
      .toString()
      .split('\n')
    for (const line of lines) {
      const [mtime = '', sessionId = ''] = line.split(' ')
      if (!SAFE_ID.test(sessionId)) continue
      const workDir = `${root}/${sessionId}`
      found.push({
        // Teammate users are named after their teammate's id (teammateUser).
        name: { sessionId, teammateId: runAs.slice('bt-'.length) },
        workDir,
        runAs,
        active: Math.max(this.state.active[workDir] ?? 0, Number(mtime) * 1000 || 0),
      })
    }
    return found
  }

  /**
   * On a member's machine, every thread folder, by its last use: noted, or
   * the last git command in one of its checkouts (the member may work in it
   * outside Brigade). A folder this runner has not seen used is used now.
   */
  private async memberCandidates() {
    const found: Candidate[] = []
    const now = Date.now()
    const root = join(HOME, 'teammates')
    const folders = async (dir: string) =>
      (await readdir(dir, { withFileTypes: true }).catch(() => []))
        .filter((entry) => entry.isDirectory() && SAFE_ID.test(entry.name))
        .map((entry) => entry.name)
    for (const teammateId of await folders(root))
      for (const sessionId of await folders(join(root, teammateId, 'threads'))) {
        const { workDir } = threadFolder(teammateId, sessionId)
        if (this.state.active[workDir] === undefined) {
          this.state.active[workDir] = now
          this.save()
        }
        const git = await Promise.all(
          (await readdir(workDir).catch(() => [] as string[])).map((entry) =>
            stat(join(workDir, entry, '.git', 'index')).then(
              (s) => s.mtimeMs,
              () => 0,
            ),
          ),
        )
        found.push({
          name: { sessionId, teammateId },
          workDir,
          active: Math.max(this.state.active[workDir], ...git),
        })
      }
    return found.sort((a, b) => a.active - b.active)
  }

  /** Remove the folder's dependency and build folders, in place. Whether anything went. */
  private async trim(candidate: Candidate) {
    const { name, workDir, runAs } = candidate
    return await this.exclusive(workDir, async () => {
      const used = () => this.used(name, workDir, TRIM_QUIET_MS)
      if (used() || !(await exists(workDir, runAs))) return false
      const paths = await regenerable(workDir, runAs)
      if (used()) return false
      // On a member's machine, its containers too: nothing else frees them there.
      if (!CLOUD) {
        await this.quiet(name)
        await removeMemberProject(name.sessionId)
      }
      if (paths.length > 0) await run('rm', ['-rf', '--', ...paths], { runAs })
      this.state.trimmedAt[workDir] = Date.now()
      if (paths.length > 0 && !this.state.trimmed.includes(workDir))
        this.state.trimmed.push(workDir)
      this.save()
      if (paths.length > 0)
        console.log(
          `trimmed ${workDir} to free disk: ${paths.map((p) => relativeTo(workDir, p)).join(', ')}`,
        )
      return paths.length > 0
    })
  }

  /** The thread's archive script, run; what fails is said in the log, and the rest goes on. */
  private async quiet(name: FolderName) {
    await this.options
      .quiet?.(name)
      .catch((error) =>
        console.warn(`archive script of ${name.sessionId} failed: ${String(error)}`),
      )
  }

  /** Remove the node_modules an older pnpm made in the folder, in place. */
  private async upgrade(candidate: Candidate) {
    const { name, workDir, runAs } = candidate
    await this.exclusive(workDir, async () => {
      const used = () => this.used(name, workDir, TRIM_QUIET_MS)
      if (used() || !(await exists(workDir, runAs))) return
      const paths = await oldPnpmModules(workDir, runAs)
      if (used()) return
      if (paths.length > 0) await run('rm', ['-rf', '--', ...paths], { runAs })
      this.state.upgradedAt[workDir] = Date.now()
      if (paths.length > 0 && !this.state.upgraded.includes(workDir))
        this.state.upgraded.push(workDir)
      this.save()
      if (paths.length > 0)
        console.log(
          `removed node_modules an older pnpm made in ${workDir}: ${paths.map((p) => relativeTo(workDir, p)).join(', ')}`,
        )
    })
  }

  /** Used since it was picked as quiet (a file read, say). */
  private used(name: FolderName, workDir: string, quietFor: number) {
    return (
      this.options.inUse(name.sessionId) ||
      Date.now() - (this.state.active[workDir] ?? 0) < quietFor
    )
  }

  private async archive(candidate: Candidate) {
    const { name, workDir, runAs } = candidate
    await this.exclusive(workDir, async () => {
      // Used since it was picked (a file read, say), or gone.
      const used = () => this.used(name, workDir, MIN_QUIET_MS)
      if (used() || !(await exists(workDir, runAs))) return
      // Deleted while this computer was offline, and never told: nothing to pack.
      if (await this.options.archives.gone(name)) return await this.removeNow(name, workDir, runAs)
      await this.quiet(name)
      // Its containers first: one writing into the folder would change it while it is packed.
      if (runAs) await removeFor(runAs, name.sessionId)
      const file = await this.tempFile()
      try {
        const size = await pack(workDir, file, runAs)
        if (size === null) {
          this.retry(workDir, TOO_LARGE_RETRY_MS)
          return console.warn(
            `kept ${workDir}: larger than ${ARCHIVE_MAX} bytes without dependencies`,
          )
        }
        // Used while it was being packed: what was packed may already be old.
        if (used()) return
        try {
          await this.options.archives.put(name, file, size)
        } catch (error) {
          // Deleted while this computer was offline, and never told.
          if (error instanceof ThreadGone) return await this.removeNow(name, workDir, runAs)
          throw error
        }
        if (used()) return
        await run('rm', ['-rf', '--', workDir], { runAs })
        delete this.state.active[workDir]
        delete this.state.retryAt[workDir]
        delete this.state.trimmedAt[workDir]
        delete this.state.upgradedAt[workDir]
        this.state.stopped = this.state.stopped.filter((dir) => dir !== workDir)
        this.state.trimmed = this.state.trimmed.filter((dir) => dir !== workDir)
        this.state.upgraded = this.state.upgraded.filter((dir) => dir !== workDir)
        this.save()
        console.log(`archived ${workDir} (${size} bytes) to free disk`)
      } finally {
        await rm(file, { force: true })
      }
    })
  }

  private async tempFile() {
    await mkdir(this.options.tempDir, { recursive: true, mode: 0o700 })
    return join(this.options.tempDir, `${randomUUID()}.tar.gz`)
  }

  private retry(workDir: string, after: number) {
    this.state.retryAt[workDir] = Date.now() + after
    this.save()
  }

  private exclusive<T>(workDir: string, work: () => Promise<T>): Promise<T> {
    const next = (this.locks.get(workDir) ?? Promise.resolve()).catch(() => undefined).then(work)
    this.locks.set(workDir, next)
    void next
      .finally(() => {
        if (this.locks.get(workDir) === next) this.locks.delete(workDir)
      })
      .catch(() => undefined)
    return next
  }

  private save() {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      void this.loaded
        .then(async () => {
          // Whole or not at all.
          const temp = `${this.options.stateFile}.${randomUUID()}.tmp`
          await mkdir(dirname(this.options.stateFile), { recursive: true, mode: 0o700 })
          await writeFile(temp, JSON.stringify(this.state), { mode: 0o600 })
          await rename(temp, this.options.stateFile)
        })
        .catch((error) => console.warn(`could not save folder state: ${String(error)}`))
    }, 5_000)
    this.saveTimer.unref()
  }
}

/** How full the disk holding teammates' homes is: the fuller of space and inodes. */
/** How full the disk with the thread folders is, by space or inodes; `free` more bytes counted as free. */
async function usage(free = 0) {
  return diskUsage(await statfs('/home'), free)
}

/** How full a disk is, 0 to 1, from its statfs, by space or inodes; `free` more bytes counted as free. */
export function diskUsage(
  s: { blocks: number; bavail: number; bsize: number; files: number; ffree: number },
  free = 0,
) {
  const space = s.blocks > 0 ? Math.max(0, 1 - (s.bavail + free / s.bsize) / s.blocks) : 0
  const inodes = s.files > 0 ? 1 - s.ffree / s.files : 0
  return Math.max(space, inodes)
}

/** Whether the disk with Brigade's folders on a member's machine runs short (MEMBER_SHORT). */
async function short() {
  const s = await statfs(HOME)
  return s.bavail * s.bsize < Math.min(MEMBER_SHORT, (s.blocks * s.bsize) / 10)
}

/** The bytes the swap file takes on the thread folders' disk; 0 without one, or on another disk. */
async function swapSize() {
  const [home, swap] = await Promise.all([stat('/home'), stat(SWAP_FILE)]).catch(() => [])
  return home && swap && home.dev === swap.dev ? swap.blocks * 512 : 0
}

const exists = (dir: string, runAs?: string) =>
  run('test', ['-d', dir], { runAs }).then(
    () => true,
    () => false,
  )

const relativeTo = (workDir: string, path: string) => path.slice(workDir.length + 1)

/** The git repositories in a folder, outside node_modules. */
async function repositories(workDir: string, runAs?: string) {
  return z(
    await run(
      'find',
      [workDir, '-name', 'node_modules', '-prune', '-o', '-name', '.git', '-print0'],
      {
        runAs,
      },
    ),
  ).map((marker) => marker.replace(/\/\.git$/, ''))
}

/**
 * The dependency and build folders in a folder, as its teammate: in each git
 * repository, the folders git ignores named in REGENERABLE; outside
 * repositories, node_modules. None holding a repository.
 */
export async function regenerable(workDir: string, runAs?: string): Promise<string[]> {
  const repos = await repositories(workDir, runAs)
  const found: string[] = []
  for (const repo of repos)
    for (const path of z(
      // A repository git cannot read keeps everything.
      await run(
        'git',
        [
          '-C',
          repo,
          'ls-files',
          '-z',
          '--others',
          '--ignored',
          '--exclude-standard',
          '--directory',
        ],
        { runAs },
      ).catch(() => Buffer.alloc(0)),
    ))
      if (path.endsWith('/') && REGENERABLE.has(basename(path)))
        found.push(`${repo}/${path.slice(0, -1)}`)
  const inRepo = (path: string) =>
    repos.some((repo) => path === repo || path.startsWith(`${repo}/`))
  for (const path of z(
    await run(
      'find',
      [workDir, '-mindepth', '1', '-name', 'node_modules', '-prune', '-type', 'd', '-print0'],
      { runAs },
    ),
  ))
    if (!inRepo(path)) found.push(path)
  // A checkout cloned into an ignored folder is work, not a build.
  return found.filter((path) => !repos.some((repo) => repo.startsWith(`${path}/`)))
}

const major = (text: string | undefined, pattern: RegExp) => {
  const found = text?.match(pattern)?.[1]
  return found === undefined ? undefined : Number(found)
}

/**
 * Whether a project's node_modules was made, wholly or partly, by a pnpm
 * before 10 while the project asks for pnpm 10 or later. pnpm 8 copied
 * packages with platform binaries (workerd, next-swc, sharp…) into each
 * node_modules rather than link them from the store; pnpm 10 installing over
 * it ignores its lockfile but keeps the package folders it finds, copies and
 * all. Such a node_modules says pnpm 10 made it and still lists the pnpm 8
 * paths (`/name/version`) it hoisted or skipped.
 */
export function madeByOldPnpm(files: {
  packageJson: string
  /** node_modules/.modules.yaml (JSON from pnpm 10, YAML before). */
  modules: string
  /** node_modules/.pnpm/lock.yaml, when there is one. */
  lock?: string
}) {
  let packageManager: unknown
  try {
    ;({ packageManager } = JSON.parse(files.packageJson) as { packageManager?: unknown })
  } catch {
    return false
  }
  if (typeof packageManager !== 'string') return false
  const wanted = major(packageManager, /^pnpm@(\d+)\./)
  if (wanted === undefined || wanted < 10) return false
  const madeBy = major(files.modules, /^\s*["']?packageManager["']?\s*:\s*["']?pnpm@(\d+)\./m)
  if (madeBy !== undefined && madeBy < 10) return true
  const lockfile = major(files.lock, /^lockfileVersion:\s*["']?(\d+)/m)
  if (lockfile !== undefined && lockfile < 9) return true
  return /^\s*(?:-\s*)?["']?\/(?:@[^/\s"']+\/)?[^/\s"']+\/\d/m.test(files.modules)
}

/**
 * The node_modules folders in a folder, as its teammate, of projects whose
 * node_modules an older pnpm made (madeByOldPnpm): the project's own and its
 * workspace packages', among those regenerable finds.
 */
export async function oldPnpmModules(workDir: string, runAs?: string): Promise<string[]> {
  const read = (path: string) => run('cat', ['--', path], { runAs }).then(String, () => undefined)
  const projects: string[] = []
  for (const modules of z(
    await run('find', [workDir, '-name', 'node_modules', '-prune', '-type', 'd', '-print0'], {
      runAs,
    }),
  )) {
    const [packageJson, modulesYaml, lock] = await Promise.all([
      read(`${dirname(modules)}/package.json`),
      read(`${modules}/.modules.yaml`),
      read(`${modules}/.pnpm/lock.yaml`),
    ])
    if (packageJson && modulesYaml && madeByOldPnpm({ packageJson, modules: modulesYaml, lock }))
      projects.push(dirname(modules))
  }
  if (projects.length === 0) return []
  return (await regenerable(workDir, runAs)).filter(
    (path) =>
      basename(path) === 'node_modules' &&
      projects.some((project) => path.startsWith(`${project}/`)),
  )
}

/**
 * Write a folder to `file` as a .tar.gz, as its teammate: in each git
 * repository in it, its .git and every file but those in folders git ignores;
 * outside repositories, everything but node_modules. Resolves to its size, or
 * null when larger than ARCHIVE_MAX.
 */
export async function pack(workDir: string, file: string, runAs?: string): Promise<number | null> {
  const list = (args: string[]) => run(args[0]!, args.slice(1), { runAs }).then(z)
  const relative = (path: string) => relativeTo(workDir, path)
  const kinds = ['(', '-type', 'f', '-o', '-type', 'd', '-o', '-type', 'l', ')']

  const repos = await repositories(workDir, runAs)
  const files = new Set<string>()
  for (const repo of repos) {
    const git = (...args: string[]) => list(['git', '-C', repo, ...args])
    const deleted = new Set(await git('ls-files', '-z', '--deleted'))
    // Copied from the member's own clone (.worktreeinclude): theirs, never sent to another computer.
    const copied = (
      await run('cat', [`${repo}/.git/${COPIED}`], { runAs }).catch(() => Buffer.alloc(0))
    )
      .toString()
      .split('\n')
      .filter(Boolean)
    const theirs = (path: string) => copied.some((c) => path === c || path.startsWith(`${c}/`))
    const kept = [
      ...(await git('ls-files', '-z', '--cached', '--others', '--exclude-standard')),
      // Ignored files (.env) stay; ignored folders (node_modules, dist, .venv, target) go.
      ...(
        await git('ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory')
      ).filter((path) => !path.endsWith('/')),
    ]
    for (const path of kept)
      if (!deleted.has(path) && !theirs(path)) files.add(relative(`${repo}/${path}`))
    for (const path of await list(['find', `${repo}/.git`, ...kinds, '-print0']))
      files.add(relative(path))
  }
  const inRepo = (path: string) =>
    repos.some((repo) => path === repo || path.startsWith(`${repo}/`))
  for (const path of await list([
    'find',
    workDir,
    '-mindepth',
    '1',
    '-name',
    'node_modules',
    '-prune',
    '-o',
    ...kinds,
    '-print0',
  ]))
    if (!inRepo(path)) files.add(relative(path))
  // Something to unpack, even for an empty folder.
  files.add('.')

  const out = createWriteStream(file, { mode: 0o600 })
  const written = finished(out)
  const packed = run(
    'bash',
    [
      '-o',
      'pipefail',
      '-c',
      'tar -C "$1" --no-recursion --null -T - -czf - | head -c "$2"',
      'pack',
      workDir,
      String(ARCHIVE_MAX + 1),
    ],
    { runAs, input: Buffer.from([...files].join('\0')), stdout: out },
  )
  const failed = await packed.then(
    () => null,
    (error: unknown) => error,
  )
  // A command that never started never ended the file.
  if (failed && !out.writableEnded) out.end()
  await written
  const { size } = await stat(file)
  // head stopped reading: too large. Anything else is a failure.
  if (size > ARCHIVE_MAX) return null
  if (failed) throw failed
  return size
}

/** Put a folder back from its archive, as its teammate. */
export async function unpack(file: string, workDir: string, runAs?: string) {
  await run('mkdir', ['-p', workDir], { runAs })
  await run('tar', ['-xzf', '-', '-C', workDir], { runAs, stdin: createReadStream(file) })
}
