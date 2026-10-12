// Thread folders on a cloud computer are a cache. Threads never end, so their
// folders cannot wait for one to: when the disk fills up, the folders of the
// threads quiet longest are archived to the API's bucket and removed, until
// there is room again. The archive keeps what the teammate made (checkouts with
// their .git, uncommitted and untracked work, notes, screenshots) and leaves
// out what can be made again: folders git ignores (dependencies, build output,
// local databases) and node_modules anywhere. Whatever next needs the folder
// (a turn, a preview, a takeover, a file read) puts it back first, and the
// teammate's next turn is told to reinstall what it needs.
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { finished } from 'node:stream/promises'
import { randomUUID } from 'node:crypto'
import type { GitAccess } from '@brigade/contracts'
import { CLOUD } from './config.js'
import { prune, removeFor, stopQuiet } from './containers.js'
import { owners, repairCaches, run } from './repos.js'
import { teammateHome } from './teammates.js'
import { threadFolder } from './threads.js'

/** Archive folders once the disk is this full (space or inodes)… */
const FULL = 0.8
/** …until it is down to this. */
const ENOUGH = 0.65
/** A thread active more recently than this keeps its folder, however full the disk. */
const MIN_QUIET_MS = 60 * 60_000
const CHECK_EVERY_MS = 5 * 60_000
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
const STOPPED =
  'Note from Brigade: the containers this thread started were stopped while it was quiet, to free the computer. ' +
  'Their data is kept: start them again (docker compose up -d, say) if you need them.'

export type FolderName = { sessionId: string; teammateId: string }

/** Archives in the API's bucket, by thread and teammate, streamed from and to files. */
export type FolderArchives = {
  /** Upload the file; resolves once the API has checked the bucket holds all of it. */
  put: (name: FolderName, file: string, size: number) => Promise<void>
  /** Download into the file; false when there is no archive. */
  get: (name: FolderName, file: string) => Promise<boolean>
  delete: (name: FolderName) => Promise<void>
}

type State = {
  /** When each folder was last used, by its path. */
  active: Record<string, number>
  /** Folders put back whose teammate has not been told yet, nor its caches fetched again. */
  restored: string[]
  /** Folders whose thread's containers were stopped, whose teammate has not been told yet. */
  stopped: string[]
  /** Folders that could not be archived, and when to try again. */
  retryAt: Record<string, number>
}

const z = (output: Buffer) => output.toString().split('\0').filter(Boolean)

export class Folders {
  private state: State = { active: {}, restored: [], stopped: [], retryAt: {} }
  private loaded: Promise<void>
  /** Work on a folder (archiving it, putting it back), one at a time per folder. */
  private locks = new Map<string, Promise<unknown>>()
  private checking = false
  private saveTimer: NodeJS.Timeout | undefined

  constructor(
    private readonly options: {
      archives: FolderArchives
      /** The thread has a turn, a person in control, a parked-but-live session or a preview. */
      inUse: (sessionId: string) => boolean
      stateFile: string
      /** Where archives are written on their way to and from the bucket. */
      tempDir: string
    },
  ) {
    this.loaded = readFile(options.stateFile, 'utf8').then(
      (text) => {
        const saved = JSON.parse(text) as Partial<State>
        // Uses noted before it loaded are newer.
        this.state = {
          active: { ...saved.active, ...this.state.active },
          restored: saved.restored ?? [],
          stopped: saved.stopped ?? [],
          retryAt: saved.retryAt ?? {},
        }
      },
      () => undefined,
    )
  }

  /** Check the disk now and then. Only on a cloud computer: a member's machine is theirs. */
  start() {
    if (!CLOUD) return
    // Left by a runner that stopped mid-way.
    void rm(this.options.tempDir, { recursive: true, force: true }).catch(() => undefined)
    const check = () =>
      void this.check().catch((error) => console.warn(`folder check failed: ${String(error)}`))
    setTimeout(check, 60_000).unref()
    setInterval(check, CHECK_EVERY_MS).unref()
  }

  /** The folder is in use now: archived last. */
  touch(name: FolderName) {
    if (!CLOUD) return
    this.state.active[threadFolder(name.teammateId, name.sessionId).workDir] = Date.now()
    this.save()
  }

  /**
   * The folder is on disk: put back from its archive when it was archived.
   * Throws when it could not be: working in an empty folder would lose it.
   */
  async ready(name: FolderName) {
    if (!CLOUD) return
    this.touch(name)
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
   * For a teammate's turn: what to tell it about its folder put back or its
   * containers stopped, once. A folder put back gets the caches its checkouts
   * borrow from fetched again.
   */
  async takeNote(name: FolderName, git: GitAccess | undefined) {
    if (!CLOUD) return undefined
    await this.loaded
    const { workDir, runAs } = threadFolder(name.teammateId, name.sessionId)
    const restored = this.state.restored.includes(workDir)
    const stopped = this.state.stopped.includes(workDir)
    if (!restored && !stopped) return undefined
    if (restored && git) await repairCaches(workDir, git, runAs)
    this.state.restored = this.state.restored.filter((dir) => dir !== workDir)
    this.state.stopped = this.state.stopped.filter((dir) => dir !== workDir)
    this.save()
    return restored ? RESTORED : STOPPED
  }

  /**
   * Stop the containers of threads gone quiet. When the disk is full, prune
   * what Docker keeps for nothing, then archive the folders of the threads
   * quiet longest until it is not.
   */
  async check() {
    if (this.checking) return
    this.checking = true
    try {
      await this.loaded
      const now = Date.now()
      const candidates = await this.candidates()
      const quiet = (c: (typeof candidates)[number]) =>
        now - c.active >= MIN_QUIET_MS && !this.options.inUse(c.name.sessionId)
      for (const runAs of new Set(candidates.map((c) => c.runAs))) {
        const mine = candidates.filter((c) => c.runAs === runAs)
        const stopped = await stopQuiet(
          runAs,
          mine.map((c) => c.name.sessionId),
          (sessionId) => mine.some((c) => c.name.sessionId === sessionId && quiet(c)),
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

      if ((await usage()) < FULL) return
      for (const runAs of await owners())
        if (runAs)
          await prune(runAs).catch((error) =>
            console.warn(`could not prune ${runAs}'s Docker: ${String(error)}`),
          )
      for (const candidate of candidates) {
        if ((await usage()) < ENOUGH) break
        if (now - candidate.active < MIN_QUIET_MS) break
        if (!quiet(candidate)) continue
        if (now < (this.state.retryAt[candidate.workDir] ?? 0)) continue
        await this.archive(candidate).catch((error) => {
          this.retry(candidate.workDir, FAILED_RETRY_MS)
          console.warn(`could not archive ${candidate.workDir}: ${String(error)}`)
        })
      }
      if ((await usage()) >= FULL)
        console.warn('the disk is still full: every thread folder left is in use or too large')
    } finally {
      this.checking = false
    }
  }

  /** Every thread folder on this computer, quiet longest first. */
  private async candidates() {
    const found: { name: FolderName; workDir: string; runAs: string; active: number }[] = []
    for (const runAs of await owners()) {
      if (!runAs) continue
      const root = `${teammateHome(runAs)}/threads`
      const lines = (
        await run(
          'find',
          [root, '-mindepth', '1', '-maxdepth', '1', '-type', 'd', '-printf', '%T@ %f\\n'],
          {
            runAs,
          },
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
    }
    return found.sort((a, b) => a.active - b.active)
  }

  private async archive(candidate: { name: FolderName; workDir: string; runAs: string }) {
    const { name, workDir, runAs } = candidate
    await this.exclusive(workDir, async () => {
      // Used since it was picked (a file read, say), or gone.
      const used = () =>
        this.options.inUse(name.sessionId) ||
        Date.now() - (this.state.active[workDir] ?? 0) < MIN_QUIET_MS
      if (used() || !(await exists(workDir, runAs))) return
      // Its containers first: one writing into the folder would change it while it is packed.
      await removeFor(runAs, name.sessionId)
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
        await this.options.archives.put(name, file, size)
        if (used()) return
        await run('rm', ['-rf', '--', workDir], { runAs })
        delete this.state.active[workDir]
        delete this.state.retryAt[workDir]
        this.state.stopped = this.state.stopped.filter((dir) => dir !== workDir)
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
async function usage() {
  const s = await statfs('/home')
  const space = s.blocks > 0 ? 1 - s.bavail / s.blocks : 0
  const inodes = s.files > 0 ? 1 - s.ffree / s.files : 0
  return Math.max(space, inodes)
}

const exists = (dir: string, runAs?: string) =>
  run('test', ['-d', dir], { runAs }).then(
    () => true,
    () => false,
  )

/**
 * Write a folder to `file` as a .tar.gz, as its teammate: in each git
 * repository in it, its .git and every file but those in folders git ignores;
 * outside repositories, everything but node_modules. Resolves to its size, or
 * null when larger than ARCHIVE_MAX.
 */
export async function pack(workDir: string, file: string, runAs?: string): Promise<number | null> {
  const list = (args: string[]) => run(args[0]!, args.slice(1), { runAs }).then(z)
  const relative = (path: string) => path.slice(workDir.length + 1)
  const kinds = ['(', '-type', 'f', '-o', '-type', 'd', '-o', '-type', 'l', ')']

  const repos = (
    await list([
      'find',
      workDir,
      '-name',
      'node_modules',
      '-prune',
      '-o',
      '-name',
      '.git',
      '-print0',
    ])
  ).map((marker) => marker.replace(/\/\.git$/, ''))
  const files = new Set<string>()
  for (const repo of repos) {
    const git = (...args: string[]) => list(['git', '-C', repo, ...args])
    const deleted = new Set(await git('ls-files', '-z', '--deleted'))
    const kept = [
      ...(await git('ls-files', '-z', '--cached', '--others', '--exclude-standard')),
      // Ignored files (.env) stay; ignored folders (node_modules, dist, .venv, target) go.
      ...(
        await git('ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory')
      ).filter((path) => !path.endsWith('/')),
    ]
    for (const path of kept) if (!deleted.has(path)) files.add(relative(`${repo}/${path}`))
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
