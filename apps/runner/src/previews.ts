// Live previews: an app a teammate runs in its thread (usually a dev server),
// kept by the runner rather than the harness, so it keeps answering after the
// turn ends and the harness session parks. One per thread; starting another
// replaces it. A person opens it from the dashboard, at an address the API
// gives out; on a cloud computer the provider hosts its ports publicly.
//
// People reach it through a proxy the runner runs in front of it (preview-proxy.ts):
// one address for all its ports, cookies that work in the dashboard's frame, and a
// page that says what is happening while the app does not answer. An app that
// stops after it ran is started again, a few times.
//
// It expires a while after anyone last used it (a teammate's preview tool, a
// person viewing it), so a forgotten dev server does not keep the computer up.
// On a cloud computer it runs in a cgroup of its own (preview-cgroup.ts): frozen
// after a few minutes without use, its thread's containers paused, until the
// next request; stopped hours later, or sooner when the computer runs short; and
// killed alone, with the reason, when it takes too much memory.
//
// A person starts one too, from the dashboard, without a turn: again as it last
// started (remembered across restarts of the runner), or from the saved setup
// of a repository checked out in the thread. Then the runner checks its pages
// itself, as a teammate's start_preview does.
//
// A repository's setup is in its checkout's .brigade/settings.toml when it has
// one (repo-settings.ts), so each branch starts as its code needs; else in the
// recipe saved in Brigade. Saving writes both. On a member's machine, the app
// listens on the loopback only, and gets the files the repository's
// .worktreeinclude names from the member's own clone (its .env).
//
// Each start reads the repository's preview variables, which people set, from
// the API: they go into the app's environment over the start's own settings,
// never into what the teammate reads; a secret's value is hidden in the log.
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import { createConnection } from 'node:net'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import type { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  PREVIEW_LOG_LINES,
  PREVIEW_REPLACED,
  type AgentEvent,
  type PreviewInfo,
  type PreviewOperation,
  type PreviewRecipe,
  type PreviewStartOutcome,
} from '@brigade/contracts'
import { CLOUD, HOME } from './config.js'
import { harnessEnv } from './harness/env.js'
import type { CheckResult } from './preview-check.js'
import { pauseFor, unpause } from './containers.js'
import {
  oomReason,
  PressureWatch,
  runnerCgroups,
  type Ooms,
  type PreviewCgroup,
} from './preview-cgroup.js'
import { PORTS_PREFIX, PreviewProxy, type ProxyState } from './preview-proxy.js'
import type { Candidate } from './memory-guard.js'
import { processGroups } from './process-groups.js'
import { asTeammate, threadNet, type ThreadNet } from './thread-net.js'
import { composeProject, containerEnv, teammateHome } from './teammates.js'
import { holderOwner, takenPorts, whoHolds } from './port-holders.js'
import {
  copyIncluded,
  otherSetups,
  readRepoPreview,
  repositoryFromRemote,
  sameStart,
  writeRepoPreview,
} from './repo-settings.js'

const run = promisify(execFile)

/** A preview nobody used for this long stops. */
const TTL_MS = Number(process.env.BRIGADE_PREVIEW_TTL_MS) || 30 * 60_000
/**
 * In a cgroup of its own (a cloud computer), a preview nobody used for this
 * long is frozen instead, its memory given back, until the next request; it
 * stops after FROZEN_TTL_MS, or sooner when the computer runs short.
 */
const FREEZE_MS = Number(process.env.BRIGADE_PREVIEW_FREEZE_MS) || 5 * 60_000
const FROZEN_TTL_MS = Number(process.env.BRIGADE_PREVIEW_FROZEN_TTL_MS) || 4 * 60 * 60_000
/** Frozen previews stop, longest unused first, while swap is this full or memory this short. */
const SWAP_FULL = 0.8
const MEMORY_SHORT = 0.1
/** How long a teammate's start_preview waits for the port, unless it says. */
export const PREVIEW_START_MS = 120_000
export const PREVIEW_START_MAX_MS = 600_000
/** Waits before starting a stopped app again; past these, within RESTART_WINDOW_MS, it has failed. */
const RESTART_DELAYS_MS = [1000, 3000, 10_000]
const RESTART_WINDOW_MS = 10 * 60_000
/**
 * Where the proxy's port is looked for. A repository's preview gets one from
 * its name, so its address stays the same on this computer (an OAuth callback
 * registered once keeps working); else one from the app's port.
 */
const PROXY_BASE = 20_000
const REPOSITORY_PROXY_BASE = 30_000
/**
 * What an app answers while it waits on its own parts (a proxy in front of a
 * server still starting): not ready yet, for up to WAITING_MS.
 */
const WAITING_STATUSES = new Set([502, 503, 504])
const WAITING_MS = Number(process.env.BRIGADE_PREVIEW_WAITING_MS) || 60_000
/** Setup (install, migrate) comes before the app answers: wait longer for it. */
const SETUP_START_MS = 600_000
/** Longest a recipe's archive script runs. */
const ARCHIVE_MS = 5 * 60_000
/** ${BRIGADE_PREVIEW_URL} and ${BRIGADE_PREVIEW_URL_<port>} in a recipe's env. */
const PLACEHOLDER = /\$\{BRIGADE_PREVIEW_URL(?:_(\d+))?\}/g
/** The page checker, beside this file (preview-check.ts). */
const CHECKER = join(
  dirname(fileURLToPath(import.meta.url)),
  `preview-check${extname(fileURLToPath(import.meta.url))}`,
)
/** Lines of the app's output that look like errors (a stack, a failed query, a 500). */
const ERROR_LINE =
  /\b(error|exception|failed|fatal|unhandled|ECONNREFUSED|ENOTFOUND)\b|⨯| 5\d\d in /i
/** Longest line kept in the log. */
const LINE_MAX = 2000
/** What the wrapper prints between the setup and the app. */
const APP_STARTS = '[preview] Starting the app'
/** A command that takes its port from $PORT runs on another one when its own is taken. */
const PORT_VARIABLE = /\$\{?PORT\b/
/** Threads whose last start is remembered, newest kept. */
const REMEMBERED_MAX = 200
/** A secret this short is not hidden in the log: it would hide ordinary words. */
const HIDDEN_MIN = 6
const HIDDEN = '••••••'

export type PreviewStart = {
  command: string
  /** Relative to the teammate's working directory. */
  cwd?: string
  port: number
  /** Other ports the app's pages call (its API), hosted too. */
  ports?: number[]
  timeoutMs?: number
  /** Run before the command when it starts (not when it restarts after a crash), stopping at a failure. */
  setup?: string
  /** Settings for setup and command; ${BRIGADE_PREVIEW_URL[_<port>]} in a value becomes the address. */
  env?: Record<string, string>
  /** Also write env to this file, relative to cwd. */
  envFile?: string
  /** Vault credentials by id, and the private env files they were released as. */
  credentials?: string[]
  envFiles?: string[]
  /** Pages its check opens. */
  paths?: string[]
  /** owner/name: its address stays the same for it on this computer. */
  repository?: string
  /** Started from a saved recipe whose check passed: its first check uses the shorter waits. */
  passed?: boolean
  /** Run in cwd when the thread goes quiet: frees what setup made outside the checkout. */
  archive?: string
}

/**
 * A repository's recipe, where its repository is checked out in the teammate's
 * directory, and where it came from: the checkout's settings files, or Brigade.
 */
export type SavedPreview = { recipe: PreviewRecipe; checkout: string; from: string[] | 'brigade' }

/** What saving wrote: the recipe in Brigade, and the checkout's settings file unless its people want none. */
export type SavedRecipe = {
  repository: string
  recipe: PreviewRecipe
  file?: { file: string; changed: boolean; local: boolean }
}

/** A check of the preview's pages, and what the app logged meanwhile that looks like an error. */
export type PreviewCheck = CheckResult & { serverErrors: string[] }

/** What a teammate's preview tools reach: its thread's preview. */
export type PreviewControl = {
  start(input: PreviewStart, signal?: AbortSignal): Promise<PreviewResult>
  /** Open these paths as a person would and say what is wrong with them. */
  check(paths: string[], signal?: AbortSignal): Promise<PreviewCheck>
  /**
   * Save the running preview as its repository's recipe: once its check passed, or with why what
   * it found is expected. `inRepository` false keeps it out of the checkout's files.
   */
  save(reason?: string, inRepository?: boolean): Promise<SavedRecipe>
  /** A repository's recipe for its checkout here; null when it has none. */
  saved(repository: string): Promise<SavedPreview | null>
  /** Setups the repository's checkout here has for other tools (orca.yaml, …), to start from. */
  otherSetups(repository: string): Promise<string[]>
  stop(): Promise<{ stopped: boolean }>
  logs(lines?: number): {
    status: PreviewInfo['status'] | 'none'
    /** Where the app answers for a person, by port, while it runs: to test on it. */
    origins?: Record<number, string>
    logs: string
  }
}

export type PreviewResult = {
  status: PreviewInfo['status']
  /** Where the app answers for a person, by port, with no token. */
  origins: Record<number, string>
  reason?: string
  logs?: string
  /** The names of the repository's preview variables the app got. */
  variables?: string[]
  /** What the start changed, for the teammate: a port something else holds, and the one it got instead. */
  notes?: string[]
}

export type Seat = { sessionId: string; teammateId: string; workDir: string; runAs?: string }

/** How a thread's preview last started, to start it again for a person. Credentials are not kept. */
type LastStart = { seat: Seat; input: Omit<PreviewStart, 'envFiles'>; repository?: string }

type Preview = {
  info: PreviewInfo
  seat: Seat
  input: PreviewStart
  /** Where the app answers for a person, by port, with no token. */
  origins: Record<number, string>
  /** Unset only until the first launch. */
  child?: ChildProcess
  proxy: PreviewProxy
  /** The app stopped and starts again: when it did, for RESTART_DELAYS_MS. */
  restarts: number[]
  restarting?: boolean
  /** The command's environment, for a restart. */
  env: NodeJS.ProcessEnv
  dir: string
  /** The process group to stop. */
  group?: number
  /** Its thread's own network, on a cloud computer: where it runs and is reached. */
  net?: ThreadNet
  /** Its own cgroup, on a cloud computer: what it may use, and how it is frozen. */
  cgroup?: PreviewCgroup
  /** The kernel's OOM counts of its cgroup when this run started. */
  ooms?: Ooms
  /** Frozen while nobody uses it; the next request thaws it. */
  frozen?: boolean
  /** Its thread's containers, paused while it is frozen. */
  pausedContainers?: string[]
  /** Freezing and thawing, one after the other. */
  pausing: Promise<unknown>
  /** Its credentials' env files, copied for as long as it runs (a turn's own go when it parks). */
  envFiles: string[]
  /** Where those copies are, removed when it ends. */
  keptDir?: string
  /** The last check of its pages: whether they all passed. */
  checked?: boolean
  /** The names of the preview variables it got, and the secrets' values, hidden in its log. */
  variables: string[]
  hidden: string[]
  lines: string[]
  /** Lines appended since it started, including those the log no longer keeps. */
  written: number
  partial: string
  lastUsed: number
  /** Set when a stop was asked for: how its exit is reported. */
  stopping?: { status: 'failed' | 'stopped'; reason: string }
  exited: Promise<number | null>
  /** What its start changed, said in the result (PreviewResult.notes). */
  notes: string[]
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\r/g

/** Whether something answers on a local port: the computer's, or a thread's own (its address). */
function answers(port: number, host = '127.0.0.1', timeoutMs = 1000) {
  return new Promise<boolean>((done) => {
    const socket = createConnection({ host, port })
    const finish = (ok: boolean) => {
      socket.destroy()
      done(ok)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

/**
 * The status an app answers `/` with, or null when it does not answer HTTP in
 * time (a dev server still compiling, an app that is not HTTP).
 */
function httpStatus(port: number, host = '127.0.0.1', timeoutMs = 10_000) {
  return new Promise<number | null>((done) => {
    const request = http.get(
      { host, port, path: '/', headers: { host: `localhost:${port}` }, timeout: timeoutMs },
      (response) => {
        response.resume()
        done(response.statusCode ?? null)
      },
    )
    request.on('timeout', () => request.destroy())
    request.on('error', () => done(null))
  })
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

export class Previews {
  private previews = new Map<string, Preview>()
  private readonly timer: NodeJS.Timeout
  /** Where previews get cgroups of their own; null where the runner's cgroup is not delegated to it. */
  private readonly cgroups = runnerCgroups()

  constructor(
    private readonly options: {
      emit: (sessionId: string, event: AgentEvent) => void
      /**
       * The public origins of a thread's ports, by port: on a cloud computer
       * from the API (the provider hosts them); null where the runner has no
       * public address (a member's own machine).
       */
      expose: ((sessionId: string, ports: number[]) => Promise<Record<number, string>>) | null
      /** What a person opens for a hosted port, with its token: to check it as they would. */
      viewUrl: ((sessionId: string, port: number) => Promise<string>) | null
      /** Read or save a repository's recipe, through the API. */
      recipes: (
        sessionId: string,
        teammateId: string,
        operation: PreviewOperation,
      ) => Promise<unknown>
      /** A teammate's seat in a thread: its working directory, and its user on a cloud computer. */
      seat: (sessionId: string, teammateId: string) => Seat
      /** Where how each thread's preview last started is kept. */
      stateFile: string
      /** A turn or a person works in the thread: its preview counts as used, so it does not freeze. */
      busy?: (sessionId: string) => boolean
    },
  ) {
    this.timer = setInterval(() => this.expire(), 60_000)
    this.timer.unref()
    this.pressureTimer = setInterval(() => void this.watchPressure(), 5_000)
    this.pressureTimer.unref()
    this.pausedFile = join(dirname(options.stateFile), 'paused-containers.json')
    void this.unpauseLeftovers()
    try {
      const saved = JSON.parse(readFileSync(options.stateFile, 'utf8')) as [string, LastStart][]
      this.lastStarts = new Map(saved)
    } catch {
      // None yet.
    }
  }

  private lastStarts = new Map<string, LastStart>()
  private readonly pressureTimer: NodeJS.Timeout
  private readonly pressure = new PressureWatch<Preview>()
  /** Containers paused for frozen previews, by user: unpaused at the next start should the runner stop first. */
  private readonly pausedFile: string

  /** Previews running or starting, frozen ones aside: nobody is using those. */
  get count() {
    return [...this.previews.values()].filter((p) => !p.frozen).length
  }

  /** The thread's preview is running or starting. */
  has(sessionId: string) {
    return this.previews.has(sessionId)
  }

  /** The repositories each seat had checked out when last told, as reported: "a,b". */
  private reported = new Map<string, string>()

  /**
   * After a turn: what the seat has checked out, reported when it changed (the
   * dashboard offers a preview once there is one). None at first says nothing.
   */
  async reportCheckouts(seat: Seat) {
    const repositories = [
      ...new Set((await checkouts(seat.workDir, seat.runAs)).map((c) => c.repository)),
    ]
      .sort()
      .slice(0, 50)
    const key = `${seat.sessionId}:${seat.teammateId}`
    const now = repositories.join(',')
    if (now === (this.reported.get(key) ?? '')) return
    this.reported.set(key, now)
    this.options.emit(seat.sessionId, {
      at: new Date().toISOString(),
      type: 'repositories.changed',
      teammateId: seat.teammateId,
      repositories,
    })
  }

  /** A seat's preview tools: its thread's preview, as its teammate. */
  forSeat(seat: Seat): PreviewControl {
    return {
      start: (input, signal) => this.start(seat, input, signal),
      check: (paths, signal) => this.check(seat, paths, signal),
      save: (reason, inRepository) => this.save(seat, reason, inRepository),
      saved: (repository) => this.saved(seat, repository),
      otherSetups: async (repository) => {
        const checkout = (await checkouts(seat.workDir, seat.runAs)).find(
          (c) => c.repository === repository.toLowerCase(),
        )
        return checkout ? otherSetups(join(seat.workDir, checkout.name), seat.runAs) : []
      },
      stop: async () => ({
        stopped: await this.stop(seat.sessionId, 'Stopped by the teammate'),
      }),
      logs: (lines) => {
        const preview = this.previews.get(seat.sessionId)
        if (preview) preview.lastUsed = Date.now()
        return {
          status: preview?.info.status ?? 'none',
          ...(preview?.info.status === 'running' ? { origins: preview.origins } : {}),
          logs: preview ? this.tail(preview, lines) : '',
        }
      },
    }
  }

  /** Someone has the preview open: it does not expire meanwhile. */
  touch(sessionId: string) {
    const preview = this.previews.get(sessionId)
    if (preview) preview.lastUsed = Date.now()
  }

  logs(sessionId: string) {
    const preview = this.previews.get(sessionId)
    if (!preview) throw new Error('This thread has no preview running')
    return this.tail(preview)
  }

  /**
   * Open the preview's pages with the computer's Chrome, at the address people
   * open, as the teammate; screenshots go in .preview-checks in its directory.
   */
  async check(seat: Seat, paths: string[], signal?: AbortSignal): Promise<PreviewCheck> {
    const preview = this.previews.get(seat.sessionId)
    if (!preview || preview.info.status !== 'running')
      throw new Error('The preview is not running: start it with start_preview first')
    preview.lastUsed = Date.now()
    const current = () => this.previews.get(seat.sessionId) === preview
    const before = preview.info.check
    preview.info = { ...preview.info, check: { status: 'checking' } }
    this.report(preview)
    try {
      const result = await this.checkPages(seat, preview, paths, signal)
      if (current()) {
        const failed = result.pages.filter((p) => !p.ok).map((p) => p.path)
        preview.checked = result.ok
        preview.info = {
          ...preview.info,
          check: result.ok
            ? { status: 'passed' }
            : { status: 'failed', failed: failed.slice(0, 10) },
        }
        this.report(preview)
      }
      return result
    } catch (error) {
      // Not checked: as it was before.
      if (current()) {
        const { check: _check, ...info } = preview.info
        preview.info = before ? { ...info, check: before } : info
        this.report(preview)
      }
      throw error
    }
  }

  private async checkPages(
    seat: Seat,
    preview: Preview,
    paths: string[],
    signal?: AbortSignal,
  ): Promise<PreviewCheck> {
    const port = preview.info.publicPort ?? preview.info.port
    const url = this.options.viewUrl
      ? await this.options.viewUrl(seat.sessionId, port)
      : `http://localhost:${port}`
    const from = preview.written
    const saved = preview.input.paths?.length ? preview.input.paths : ['/']
    // A recheck after a passed one, with no pages given: the first is enough to see it still renders.
    const pages = paths.length ? paths : preview.checked ? saved.slice(0, 1) : saved
    const input = JSON.stringify({
      url,
      paths: pages,
      out: join(seat.workDir, '.preview-checks'),
      quick: preview.checked ?? preview.input.passed === true,
    })
    const args = [CHECKER, input]
    const { stdout } = await run(
      seat.runAs ? 'sudo' : process.execPath,
      seat.runAs ? ['-n', '-u', seat.runAs, process.execPath, ...args] : args,
      // An interrupted turn does not wait for the check.
      { cwd: '/', timeout: 60_000 + pages.length * 120_000, maxBuffer: 1024 * 1024, signal },
    ).catch((error: { stderr?: string } & Error) => {
      throw new Error(
        `Could not check the preview: ${(error.stderr || error.message).trim().slice(0, 1000)}`,
      )
    })
    const result = JSON.parse(stdout) as CheckResult
    // What the app logged while its pages loaded (of the lines the log still keeps).
    const fresh = Math.min(preview.written - from, preview.lines.length)
    const logged = fresh > 0 ? preview.lines.slice(-fresh) : []
    const serverErrors = logged.filter((line) => ERROR_LINE.test(line)).slice(-20)
    return { ...result, serverErrors }
  }

  /** Whether the thread's preview runs and its last check passed. */
  checked(sessionId: string) {
    const preview = this.previews.get(sessionId)
    return preview?.info.status === 'running' && preview.checked === true
  }

  /**
   * The running preview as its repository's recipe, saved through the API and
   * in its checkout's .brigade/settings.toml, unless the repository's people
   * want none of Brigade's files (as said before, or now). Only once its check passed.
   */
  async save(seat: Seat, reason?: string, inRepository?: boolean): Promise<SavedRecipe> {
    const preview = this.previews.get(seat.sessionId)
    if (!preview || preview.info.status !== 'running')
      throw new Error('No preview is running: start it with start_preview first')
    if (!preview.checked && !reason?.trim())
      throw new Error(
        'Its last check did not pass, or it was not checked: fix what check_preview finds, then save it ' +
          '(or, if a page is meant to look that way, save it with the reason)',
      )
    const found = await repositoryOf(preview.dir, seat.runAs)
    if (!found)
      throw new Error("The preview's directory is not in a checkout of a GitHub repository")
    const { input } = preview
    const recipe: PreviewRecipe = {
      ...(input.setup?.trim() ? { setup: input.setup } : {}),
      command: input.command,
      cwd: relative(found.root, preview.dir),
      port: input.port,
      ports: preview.info.ports,
      env: input.env ?? {},
      ...(input.envFile ? { envFile: input.envFile } : {}),
      credentials: input.credentials ?? [],
      paths: input.paths?.length ? input.paths : ['/'],
      ...(input.timeoutMs ? { timeoutSeconds: Math.round(input.timeoutMs / 1000) } : {}),
      ...(preview.checked ? { passed: true } : {}),
      ...(input.archive?.trim() ? { archive: input.archive } : {}),
    }
    const before = await this.recipe(seat, found.repository).catch(() => null)
    if ((inRepository ?? before?.inRepository) === false) recipe.inRepository = false
    await this.options.recipes(seat.sessionId, seat.teammateId, {
      name: 'save',
      repository: found.repository,
      recipe,
    })
    if (recipe.inRepository === false) return { repository: found.repository, recipe }
    const file = await writeRepoPreview(found.root, recipe, seat.runAs)
    return { repository: found.repository, recipe, file }
  }

  /** A repository's recipe for its checkout here, and the directory it is checked out in. */
  async saved(seat: Seat, name: string): Promise<SavedPreview | null> {
    const repository = name.toLowerCase()
    const checkout = (await checkouts(seat.workDir, seat.runAs)).find(
      (c) => c.repository === repository,
    )?.name
    if (!checkout) {
      if (!(await this.recipe(seat, repository))) return null
      throw new Error(
        `${repository} has a saved preview, but it is not checked out here: check it out with checkout_repository first`,
      )
    }
    const found = await this.recipeFor(seat, repository, checkout)
    if (found.error)
      throw new Error(
        `${found.error}. Fix it in ${checkout}, or start the preview with its command and port.`,
      )
    return found.recipe ? { recipe: found.recipe, checkout, from: found.from } : null
  }

  /**
   * A repository's recipe for a checkout of it here: what its branch's
   * .brigade/ settings say, with the vault credentials saved in Brigade (the
   * workspace's, not the repository's); else the recipe saved in Brigade.
   * `error`: its settings could not be read, said for the teammate to fix.
   */
  private async recipeFor(
    seat: Seat,
    repository: string,
    checkout: string,
  ): Promise<{ recipe?: PreviewRecipe; from: string[] | 'brigade'; error?: string }> {
    const [inRepository, saved] = await Promise.all([
      readRepoPreview(join(seat.workDir, checkout), seat.runAs),
      this.recipe(seat, repository).catch((error: unknown) => {
        console.warn(`could not read the saved preview of ${repository}: ${String(error)}`)
        return null
      }),
    ])
    if (!inRepository.found) return saved ? { recipe: saved, from: 'brigade' } : { from: 'brigade' }
    if ('error' in inRepository)
      return { ...(saved ? { recipe: saved } : {}), from: 'brigade', error: inRepository.error }
    const recipe = inRepository.recipe
    return {
      recipe: {
        ...recipe,
        credentials: saved?.credentials ?? [],
        // Its check passed as saved: the same start needs no longer waits.
        ...(saved?.passed && sameStart(saved, recipe) ? { passed: true } : {}),
      },
      from: inRepository.files,
    }
  }

  /** Start the preview again, as it was started. */
  async restart(sessionId: string) {
    const preview = this.previews.get(sessionId)
    if (!preview) throw new Error('This thread has no preview running')
    await this.startInBackground(preview.seat, { ...preview.input, envFiles: preview.envFiles })
  }

  /** Stop a thread's preview, reported as stopped or failed. Returns whether one was running. */
  async stop(sessionId: string, reason: string, status: 'failed' | 'stopped' = 'stopped') {
    const preview = this.previews.get(sessionId)
    if (!preview) return false
    preview.stopping = { status, reason }
    // A frozen process only gets to its SIGTERM handler once thawed.
    await this.thaw(preview)
    this.kill(preview, 'TERM')
    const killed = await Promise.race([preview.exited.then(() => true), sleep(5000)])
    if (!killed) {
      this.kill(preview, 'KILL')
      await Promise.race([preview.exited, sleep(2000)])
    }
    // The exit handler reports it; if the process never exits, report it here.
    if (this.previews.get(sessionId) === preview) this.ended(preview, status, reason)
    return true
  }

  async stopAll(reason: string) {
    await Promise.all([...this.previews.keys()].map((id) => this.stop(id, reason)))
  }

  /**
   * The thread went quiet, or leaves this computer: its preview stops, and the
   * archive script it last started with runs, as the teammate, with the
   * preview's settings and variables, to free what its setup made outside the
   * checkout. Rejects with what it printed when it fails.
   */
  async archive(sessionId: string) {
    await this.stop(sessionId, 'The thread went quiet')
    const last = this.lastStarts.get(sessionId)
    const script = last?.input.archive?.trim()
    if (!last || !script) return
    const { seat, input } = last
    const dir = resolve(seat.workDir, input.cwd ?? '.')
    const variables = last.repository
      ? await this.variables(seat, last.repository).catch(() => ({ env: {} }))
      : { env: {} }
    const env = harnessEnv({
      ...(seat.runAs
        ? {
            ...(await containerEnv(seat.runAs, seat.sessionId)),
            HOME: teammateHome(seat.runAs),
            USER: seat.runAs,
            LOGNAME: seat.runAs,
          }
        : { COMPOSE_PROJECT_NAME: composeProject(seat.sessionId) }),
      ...input.env,
      ...variables.env,
    })
    const as = seat.runAs ? asTeammate(seat.runAs, await threadNet(sessionId)) : null
    const [file, args] = as
      ? [as.file, [...as.args, 'sh', '-c', 'cd -- "$0" && exec sh -c "$1"', dir, script]]
      : ['sh', ['-c', script]]
    try {
      await run(file, args, {
        cwd: as ? '/' : dir,
        env,
        timeout: ARCHIVE_MS,
        maxBuffer: 4 * 1024 * 1024,
      })
      console.log(`ran the archive script of ${sessionId}'s preview`)
    } catch (error) {
      const { stdout = '', stderr = '' } = error as { stdout?: string; stderr?: string }
      throw new Error(`${String(error)}\n${`${stdout}${stderr}`.slice(-2000)}`)
    }
  }

  private async start(seat: Seat, input: PreviewStart, signal?: AbortSignal) {
    const { preview, origins } = await this.begin(seat, input)
    await this.untilReady(preview, waitFor(preview.input), signal)

    const result: PreviewResult = { status: preview.info.status, origins }
    if (preview.info.reason) result.reason = preview.info.reason
    if (preview.variables.length) result.variables = preview.variables
    if (preview.notes.length) result.notes = preview.notes
    if (preview.info.status !== 'running') result.logs = this.tail(preview, 60)
    return result
  }

  /**
   * A person starts the thread's preview from the dashboard, without a turn:
   * again as it last started, or from the saved setup of a repository one of
   * these teammates has checked out in the thread. Says what came of it once
   * it is starting; its events tell the rest, its check included.
   */
  async startFor(
    sessionId: string,
    teammateIds: string[],
    repository?: string,
  ): Promise<PreviewStartOutcome> {
    if (this.previews.has(sessionId)) return { outcome: 'running' }
    const wanted = repository?.toLowerCase()
    const needsTeammate = (name: string): PreviewStartOutcome => ({
      outcome: 'teammate',
      repository: name,
      reason: 'It uses credentials from the vault, which only its teammate can release',
    })

    const last = this.lastStarts.get(sessionId)
    if (last && (!wanted || last.repository === wanted)) {
      if (last.input.credentials?.length) return needsTeammate(last.repository ?? '')
      await this.startInBackground(last.seat, last.input)
      return { outcome: 'started' }
    }

    const found: string[] = []
    for (const teammateId of teammateIds) {
      const seat = this.options.seat(sessionId, teammateId)
      for (const checkout of await checkouts(seat.workDir, seat.runAs)) {
        if (wanted && checkout.repository !== wanted) continue
        if (!found.includes(checkout.repository)) found.push(checkout.repository)
        const { recipe, error } = await this.recipeFor(seat, checkout.repository, checkout.name)
        if (error) console.warn(`${checkout.repository} in ${seat.workDir}: ${error}`)
        if (!recipe) continue
        if (recipe.credentials.length) return needsTeammate(checkout.repository)
        await this.startInBackground(seat, fromRecipe(recipe, checkout.name, checkout.repository))
        return { outcome: 'started' }
      }
    }
    return { outcome: 'setup', repositories: found }
  }

  /** Start it, then wait for it and check its pages without anyone waiting on the result. */
  private async startInBackground(seat: Seat, input: PreviewStart) {
    const { preview } = await this.begin(seat, input)
    void (async () => {
      await this.untilReady(preview, waitFor(preview.input))
      if (this.previews.get(seat.sessionId) !== preview || preview.info.status !== 'running') return
      await this.check(seat, []).catch((error: unknown) => {
        this.append(preview, `[preview] Its pages could not be checked: ${String(error)}\n`)
      })
    })().catch((error: unknown) => console.warn(`preview start failed: ${String(error)}`))
  }

  /** A repository's saved recipe, or null. */
  private async recipe(seat: Seat, repository: string) {
    const { recipe } = (await this.options.recipes(seat.sessionId, seat.teammateId, {
      name: 'get',
      repository,
    })) as { recipe: PreviewRecipe | null }
    return recipe
  }

  /** A repository's preview variables, with their values: for the app's environment only. */
  private async variables(seat: Seat, repository: string) {
    try {
      return (await this.options.recipes(seat.sessionId, seat.teammateId, {
        name: 'variables',
        repository,
      })) as { env: Record<string, string>; secrets: string[] }
    } catch (error) {
      throw new Error(
        `Could not read the preview variables of ${repository}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /** Start the app and its proxy; resolves once it is starting, with the addresses of its ports. */
  private async begin(seat: Seat, input: PreviewStart) {
    const command = input.command.trim()
    if (!command) throw new Error('Give the command that starts the app')
    const dir = resolve(seat.workDir, input.cwd ?? '.')
    const cwd = relative(seat.workDir, dir)
    if (cwd === '..' || cwd.startsWith(`..${sep}`))
      throw new Error('cwd must be inside your working directory')
    // Before the preview it replaces ends: a restart copies that one's copies.
    const kept = await keepEnvFiles(seat, input.envFiles ?? [])
    try {
      return await this.launchNew(seat, input, command, dir, cwd, kept)
    } catch (error) {
      if (kept.dir) void dropEnvFiles(seat, kept.dir)
      throw error
    }
  }

  private async launchNew(
    seat: Seat,
    input: PreviewStart,
    command: string,
    dir: string,
    cwd: string,
    kept: { dir?: string; files: string[] },
  ) {
    // One preview per thread: a new one replaces it, which frees its ports.
    await this.stop(seat.sessionId, PREVIEW_REPLACED)
    // In the thread's own network (thread-net.ts), its ports are its own: another thread's
    // preview of the same app does not take them.
    const net = seat.runAs ? await threadNet(seat.sessionId) : null
    const host = net?.address
    const others = (input.ports ?? []).filter((p) => p !== input.port)
    const notes: string[] = []
    // Taken (another thread's preview of the same app): a command reading $PORT gets a free one.
    if (PORT_VARIABLE.test(command) && (await answers(input.port, host))) {
      const held = await this.heldBy(input.port, seat, net)
      for (let port = input.port + 1; port < input.port + 100 && port <= 65535; port++) {
        if (others.includes(port) || (await answers(port, host))) continue
        notes.push(
          `Port ${input.port} is held by ${held?.text ?? 'another process'}: the app runs on ${port} (PORT) instead.`,
        )
        input = { ...input, port }
        break
      }
    }
    const ports = [...new Set(others.filter((p) => p !== input.port))]
    const all = [input.port, ...ports]
    for (const port of all) {
      if (!(await answers(port, host))) continue
      const held = await this.heldBy(port, seat, net)
      const instead =
        port === input.port
          ? 'write the command with $PORT (e.g. "pnpm dev --port $PORT"): then it gets a free port'
          : 'have the app use another port for it'
      throw new Error(
        !held
          ? `Port ${port} is already in use ${net ? 'in this thread' : 'on this computer'}, by a process you started. ` +
              `Stop that process, or ${instead}.`
          : held.own
            ? `Port ${port} is held by ${held.text}. Stop it, or ${instead}.`
            : `Port ${port} is held by ${held.text}, which is not this thread's: leave it running, and ${instead}.`,
      )
    }

    const checkout = await repositoryOf(dir, seat.runAs)
    // The member's .env and the like, which their own clone has (.worktreeinclude).
    if (!CLOUD && checkout)
      await copyIncluded(checkout.root, checkout.repository).catch((error: unknown) =>
        console.warn(`could not copy the files .worktreeinclude names: ${String(error)}`),
      )
    const repository = input.repository?.toLowerCase() ?? checkout?.repository
    const variables = repository ? await this.variables(seat, repository) : { env: {}, secrets: [] }

    // The proxy is what people reach: its port is the one hosted, the app's other ports are paths on it.
    let preview: Preview | undefined
    const proxyOptions = {
      ...(host ? { host } : {}),
      // On a member's machine, people open it there only: nobody else on its network reaches it.
      ...(CLOUD ? {} : { bind: '127.0.0.1' }),
      port: input.port,
      ports,
      crossSiteCookies: false,
      state: (): ProxyState => {
        if (!preview || preview.info.status === 'running') return 'running'
        if (preview.restarting) return 'restarting'
        return preview.info.status === 'starting' ? 'starting' : 'down'
      },
      onUse: () => {
        if (preview) preview.lastUsed = Date.now()
      },
      // A request to a frozen preview thaws it first.
      wake: () => (preview?.frozen ? this.thaw(preview) : undefined),
    }
    const proxy = new PreviewProxy(proxyOptions)
    let origin: string
    let publicPort: number
    try {
      const from = repository
        ? REPOSITORY_PROXY_BASE +
          (createHash('sha256').update(repository).digest().readUInt32BE() % 10_000)
        : PROXY_BASE + (input.port % 10_000)
      publicPort = await proxy.listen(from, all)
      origin = this.options.expose
        ? (await this.options.expose(seat.sessionId, [publicPort]))[publicPort]!
        : `http://localhost:${publicPort}`
    } catch (error) {
      proxy.close()
      throw error
    }
    origin = origin.replace(/\/+$/, '')
    // In the dashboard's frame (another site), only these cookies are kept; they need HTTPS.
    proxyOptions.crossSiteCookies = origin.startsWith('https:')
    const origins: Record<number, string> = Object.fromEntries([
      [input.port, origin],
      ...ports.map((p) => [p, `${origin}${PORTS_PREFIX}${p}`]),
    ])

    const env = harnessEnv({
      ...(seat.runAs
        ? {
            ...(await containerEnv(seat.runAs, seat.sessionId)),
            HOME: teammateHome(seat.runAs),
            USER: seat.runAs,
            LOGNAME: seat.runAs,
          }
        : { COMPOSE_PROJECT_NAME: composeProject(seat.sessionId) }),
      PORT: String(input.port),
      // On a cloud computer, reachable from the proxy whatever address it binds. On a member's
      // machine, the proxy is on the loopback too, and nobody else on its network needs the app.
      HOST: CLOUD ? '0.0.0.0' : '127.0.0.1',
      BRIGADE_PREVIEW_URL: origins[input.port]!,
      ...Object.fromEntries(all.map((p) => [`BRIGADE_PREVIEW_URL_${p}`, origins[p]!])),
      // People's variables over the start's own settings.
      ...withAddresses({ ...input.env, ...variables.env }, origin, origins),
    })
    if (input.envFile) {
      try {
        await writeEnvFile(
          dir,
          input.envFile,
          withAddresses({ ...input.env, ...variables.env }, origin, origins),
          seat.runAs,
        )
        // Secrets in a file in the checkout: never committed.
        if (variables.secrets.length) await keepOutOfGit(dir, input.envFile, seat.runAs)
      } catch (error) {
        proxy.close()
        throw error
      }
    }
    const commit = checkout ? await commitOf(dir, seat.runAs) : null
    const previewId = randomUUID()
    // Its own cgroup where the runner has them; without one it runs as before.
    const cgroup = await (
      await this.cgroups
    )
      ?.create(`${seat.sessionId}-${previewId.slice(0, 8)}`)
      .catch((error: unknown) => {
        console.warn(`preview without a cgroup: ${String(error)}`)
        return undefined
      })

    preview = {
      info: {
        previewId,
        status: 'starting',
        command,
        cwd,
        port: input.port,
        ports,
        publicPort,
        step: input.setup?.trim() ? 'setup' : 'app',
        ...(repository ? { repository } : {}),
        ...(commit ? { commit } : {}),
        startedAt: new Date().toISOString(),
      },
      seat,
      input,
      origins,
      env,
      dir,
      proxy,
      ...(net ? { net } : {}),
      ...(cgroup ? { cgroup } : {}),
      pausing: Promise.resolve(),
      envFiles: kept.files,
      ...(kept.dir ? { keptDir: kept.dir } : {}),
      variables: Object.keys(variables.env),
      hidden: variables.secrets
        .map((name) => variables.env[name] ?? '')
        .filter((value) => value.length >= HIDDEN_MIN),
      restarts: [],
      lines: [],
      written: 0,
      partial: '',
      lastUsed: Date.now(),
      exited: Promise.resolve(null),
      notes,
    }
    this.previews.set(seat.sessionId, preview)
    this.remember(seat, input, repository)
    this.report(preview)
    this.launch(preview, true)
    return { preview, origins }
  }

  /** Keep how the thread's preview started, so a person can start it again after it stopped. */
  private remember(seat: Seat, input: PreviewStart, repository: string | undefined) {
    const { envFiles: _envFiles, ...kept } = input
    this.lastStarts.delete(seat.sessionId)
    this.lastStarts.set(seat.sessionId, {
      seat,
      input: kept,
      ...(repository ? { repository } : {}),
    })
    while (this.lastStarts.size > REMEMBERED_MAX)
      this.lastStarts.delete(this.lastStarts.keys().next().value!)
    try {
      mkdirSync(dirname(this.options.stateFile), { recursive: true })
      const temp = `${this.options.stateFile}.tmp`
      writeFileSync(temp, JSON.stringify([...this.lastStarts]), { mode: 0o600 })
      renameSync(temp, this.options.stateFile)
    } catch (error) {
      console.warn(`could not save previews: ${String(error)}`)
    }
  }

  /** Run the preview's command (again), as the teammate; its setup first unless it restarts. */
  private launch(preview: Preview, withSetup: boolean) {
    const { cgroup } = preview
    // With a cgroup of its own, it offers itself first to the kernel's OOM killer should the
    // whole computer run out.
    const script = cgroup
      ? 'cd -- "$0" || exit 1; { echo 500 >/proc/self/oom_score_adj; } 2>/dev/null; exec sh -c "$1" </dev/null'
      : 'cd -- "$0" || exit 1; exec sh -c "$1" </dev/null'
    const { runAs } = preview.seat
    const { setup } = preview.input
    const { envFiles } = preview
    const command = [
      // Credentials' variables, from the private files the vault released them as.
      ...envFiles.map((file) => `set -a; . ${quote(file)}; set +a`),
      ...(withSetup && setup?.trim()
        ? [
            'echo "[preview] Running the setup"',
            // Its own shell: set -e has no effect in a list followed by ||.
            `sh -ec ${quote(setup)} || { echo "[preview] The setup failed" >&2; exit 1; }`,
            `echo ${quote(APP_STARTS)}`,
          ]
        : []),
      preview.info.command,
    ].join('\n')
    const as = runAs ? asTeammate(runAs, preview.net ?? null) : { file: 'sh', args: [] }
    const argv = [...as.args, ...(runAs ? ['sh'] : []), '-c', script, preview.dir, command]
    // With a cgroup of its own, a shell first waits on fd 3 until the runner moved it in, then
    // becomes the command: all it starts is in there from the start. Its pid is the computer's
    // whatever namespaces the app runs in (thread-net.ts), and, detached, it leads the process
    // group that sudo keeps for the app: the one to stop.
    const child = cgroup
      ? spawn('sh', ['-c', 'read -r _ <&3; exec "$@"', 'sh', as.file, ...argv], {
          cwd: '/',
          env: preview.env,
          stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
          detached: true,
        })
      : spawn(as.file, argv, {
          cwd: '/',
          env: preview.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        })
    preview.child = child
    preview.group = child.pid
    processGroups.add(child.pid, `the preview of ${preview.seat.sessionId}`)
    preview.exited = new Promise((done) => {
      child.once('error', () => done(null))
      child.once('close', (code) => done(code))
    })
    const gate = child.stdio[3] as Writable | undefined
    if (gate) {
      gate.on('error', () => undefined)
      void (child.pid ? this.enter(preview, cgroup!, child.pid) : Promise.resolve()).finally(() =>
        gate.end('\n'),
      )
    }
    child.stdout!.on('data', (data: Buffer) => this.append(preview, data.toString('utf8')))
    child.stderr!.on('data', (data: Buffer) => this.append(preview, data.toString('utf8')))
    void preview.exited.then(async (code) => {
      // Killed for memory: say so rather than the bare exit code.
      const budget = (await this.cgroups)?.budget
      const oom = cgroup && budget && oomReason(preview.ooms, await cgroup.ooms(), budget)
      if (this.previews.get(preview.seat.sessionId) !== preview || preview.child !== child) return
      if (preview.stopping)
        return this.ended(preview, preview.stopping.status, preview.stopping.reason)
      const how = oom || (code === null ? 'could not start' : `exited with code ${code}`)
      const ran = preview.info.status === 'running' || preview.restarting
      // Not after the kernel killed it for memory: started again at once, it would need it again.
      if (ran && !oom && this.restartAfterExit(preview, how)) return
      // It never ran, for want of a port (the app's, or one its containers publish): say who has it.
      const taken = ran || preview.net ? '' : await this.takenSaid(preview)
      if (this.previews.get(preview.seat.sessionId) !== preview || preview.child !== child) return
      this.ended(
        preview,
        'failed',
        ran ? `The app stopped: it ${how}` : `The command ${how}${taken}`,
      )
    })
  }

  /** An app that ran stopped: start it again after a while, unless it did too often. */
  private restartAfterExit(preview: Preview, how: string) {
    const now = Date.now()
    preview.restarts = preview.restarts.filter((at) => now - at < RESTART_WINDOW_MS)
    const delay = RESTART_DELAYS_MS[preview.restarts.length]
    if (delay === undefined) return false
    preview.restarts.push(now)
    preview.restarting = true
    preview.info = {
      ...preview.info,
      status: 'starting',
      reason: `The app stopped (it ${how}) and is starting again`,
    }
    this.append(preview, `[preview] The app ${how}; starting it again in ${delay / 1000}s\n`)
    this.report(preview)
    // What the command left behind (a dev server's children) would hold the port.
    this.kill(preview, 'KILL')
    setTimeout(() => {
      if (this.previews.get(preview.seat.sessionId) !== preview || preview.stopping) return
      this.launch(preview, false)
      void this.untilReady(preview, PREVIEW_START_MAX_MS)
    }, delay)
    return true
  }

  /**
   * Wait for the app to answer, its process to end, or the time to run out. An
   * app answering 502, 503 or 504 (a page saying it starts) is waited on a while longer.
   */
  private async untilReady(preview: Preview, waitMs: number, signal?: AbortSignal) {
    const { sessionId } = preview.seat
    const deadline = Date.now() + waitMs
    let waitingSince: number | undefined
    while (this.previews.get(sessionId) === preview && preview.info.status === 'starting') {
      const host = preview.net?.address
      if (await answers(preview.input.port, host)) {
        const status = await httpStatus(preview.input.port, host)
        if (this.previews.get(sessionId) !== preview || preview.info.status !== 'starting') return
        const now = Date.now()
        waitingSince =
          status !== null && WAITING_STATUSES.has(status) ? (waitingSince ?? now) : undefined
        if (waitingSince !== undefined && now - waitingSince < WAITING_MS && now < deadline) {
          await sleep(1000)
          continue
        }
        preview.restarting = false
        const { reason: _reason, step: _step, ...info } = preview.info
        preview.info = { ...info, status: 'running' }
        this.report(preview)
        return
      }
      if (signal?.aborted) {
        await this.stop(sessionId, 'The turn was interrupted while the app started')
        return
      }
      if (Date.now() > deadline) {
        await this.stop(
          sessionId,
          `Nothing answered on port ${preview.input.port} within ${Math.round(waitMs / 1000)} seconds`,
          'failed',
        )
        return
      }
      await sleep(500)
    }
  }

  /** Move the waiting shell into the preview's cgroup, before it becomes the command. */
  private async enter(preview: Preview, cgroup: PreviewCgroup, pid: number) {
    try {
      preview.ooms = await cgroup.ooms()
      await cgroup.attach(pid)
    } catch (error) {
      this.append(preview, `[preview] Runs without its own cgroup: ${String(error)}\n`)
    }
  }

  /** Nobody used it for a while: its processes stop where they are, and its memory goes to swap. */
  private freeze(preview: Preview) {
    const { cgroup } = preview
    if (!cgroup || preview.frozen || preview.info.status !== 'running' || preview.stopping) return
    preview.frozen = true
    return this.pause(preview, async () => {
      await cgroup.freeze()
      const freed = await cgroup.reclaim()
      this.append(
        preview,
        `[preview] Paused after ${Math.round(FREEZE_MS / 60_000)} minutes without use ` +
          `(${Math.round(freed / 1024 ** 2)} MB given back); the next request resumes it\n`,
      )
      await this.pauseContainers(preview)
    })
  }

  /**
   * Resumed, for a request or to stop it. Resolves once the app runs again; its
   * containers follow (an app that queries its database meanwhile waits a little).
   */
  private thaw(preview: Preview) {
    if (!preview.frozen) return preview.pausing
    preview.frozen = false
    const thawed = this.pause(preview, async () => {
      await preview.cgroup?.thaw()
      this.append(preview, '[preview] Resumed\n')
    })
    void this.pause(preview, () => this.unpauseContainers(preview))
    return thawed
  }

  /**
   * A turn or a person is about to work in the thread: its frozen preview runs
   * again, with the containers it paused (its database, say). The teammate may
   * call it directly, not through the proxy that wakes it.
   */
  threadBusy(sessionId: string) {
    const preview = this.previews.get(sessionId)
    if (!preview) return
    preview.lastUsed = Date.now()
    return this.thaw(preview)
  }

  /** The thread's containers, on a cloud computer, while nobody works in it. */
  private async pauseContainers(preview: Preview) {
    const { runAs, sessionId } = preview.seat
    if (!runAs || !preview.frozen || preview.pausedContainers || this.options.busy?.(sessionId))
      return
    const ids = await pauseFor(runAs, sessionId).catch((error: unknown) => {
      this.append(preview, `[preview] Could not pause the thread's containers: ${String(error)}\n`)
      return []
    })
    if (ids.length === 0) return
    preview.pausedContainers = ids
    this.savePaused()
    this.append(
      preview,
      ids[0] === '*'
        ? "[preview] Paused the thread's Docker, its containers with it\n"
        : `[preview] Paused ${ids.length} of the thread's containers\n`,
    )
  }

  private async unpauseContainers(preview: Preview) {
    const ids = preview.pausedContainers
    delete preview.pausedContainers
    if (!ids?.length || !preview.seat.runAs) return
    await unpause(preview.seat.runAs, preview.seat.sessionId, ids).catch((error: unknown) => {
      this.append(preview, `[preview] Could not resume the thread's containers: ${String(error)}\n`)
    })
    this.savePaused()
  }

  private savePaused() {
    const paused: [string, string, string[]][] = []
    for (const p of this.previews.values())
      if (p.seat.runAs && p.pausedContainers?.length)
        paused.push([p.seat.runAs, p.seat.sessionId, p.pausedContainers])
    try {
      writeFileSync(this.pausedFile, JSON.stringify(paused), { mode: 0o600 })
    } catch (error) {
      console.warn(`could not save the paused containers: ${String(error)}`)
    }
  }

  /** Containers paused for previews of a runner that stopped before it could resume them. */
  private async unpauseLeftovers() {
    // [user, thread, ids]; [user, ids] from before threads had their own Docker.
    let paused: ([string, string, string[]] | [string, string[]])[]
    try {
      paused = JSON.parse(await readFile(this.pausedFile, 'utf8')) as typeof paused
    } catch {
      return
    }
    for (const entry of paused) {
      const [user, sessionId, ids] = entry.length === 3 ? entry : [entry[0], '', entry[1]]
      await unpause(user, sessionId, ids).catch((error: unknown) =>
        console.warn(`could not resume the containers of ${user}: ${String(error)}`),
      )
    }
    this.savePaused()
  }

  /**
   * Stop a preview stalled on memory for a while (PressureWatch), at once and
   * with the reason: it would only grow slower and slow everything else.
   */
  private async watchPressure() {
    const running = [...this.previews.values()].filter((p) => p.cgroup && !p.frozen && !p.stopping)
    if (running.length === 0) return
    const readings = await Promise.all(
      running.map(async (p) => ({
        key: p,
        pressure: await p.cgroup!.pressure(),
        memory: await p.cgroup!.current(),
      })),
    )
    const stalled = this.pressure.observe(readings, Date.now())
    if (!stalled || stalled.stopping || this.previews.get(stalled.seat.sessionId) !== stalled)
      return
    const memory = readings.find((r) => r.key === stalled)!.memory
    this.killNow(
      stalled,
      `it was stuck waiting for memory for ${Math.round(this.pressure.duration / 1000)} s, ` +
        `with ${(memory / 1024 ** 3).toFixed(1)} GB in use`,
    )
  }

  /**
   * For the computer's memory guard (memory-guard.ts): the previews in cgroups,
   * what they hold in memory, and how to stop one at once.
   */
  async memoryCandidates(): Promise<Candidate[]> {
    const candidates: Candidate[] = []
    for (const preview of this.previews.values()) {
      if (!preview.cgroup || preview.stopping) continue
      const memory = await preview.cgroup.resident()
      candidates.push({
        kind: preview.frozen ? 'frozen' : 'preview',
        memory,
        lastUsed: preview.lastUsed,
        stop: async (why) =>
          this.killNow(
            preview,
            preview.frozen
              ? `${why}, and it was the paused preview unused longest`
              : `${why}, and it held the most memory (${(memory / 1024 ** 3).toFixed(1)} GB)`,
          ),
      })
    }
    return candidates
  }

  /** Killed now, all of it (a frozen one too), reported as failed for `why`. */
  private killNow(preview: Preview, why: string) {
    if (preview.stopping || this.previews.get(preview.seat.sessionId) !== preview) return
    const status = preview.info.status === 'running' ? 'The app stopped' : 'The command stopped'
    preview.stopping = { status: 'failed', reason: `${status}: ${why}` }
    this.append(preview, `[preview] ${preview.stopping.reason}\n`)
    this.kill(preview, 'KILL')
  }

  /** Freezing and thawing in the order they were asked for: a request may come while it freezes. */
  private pause(preview: Preview, change: () => Promise<void>) {
    preview.pausing = preview.pausing.then(change).catch((error: unknown) => {
      this.append(preview, `[preview] Could not pause or resume it: ${String(error)}\n`)
    })
    return preview.pausing
  }

  private kill(preview: Preview, signal: 'TERM' | 'KILL') {
    // Whatever left its process group too (a daemon, a setsid'd child) is still in its cgroup.
    if (signal === 'KILL') void preview.cgroup?.kill()
    const group = preview.group
    if (!group) {
      preview.child?.kill(signal === 'TERM' ? 'SIGTERM' : 'SIGKILL')
      return
    }
    if (preview.seat.runAs) {
      // The group is the teammate's: signal it as the teammate.
      spawn(
        'sudo',
        ['-n', '-u', preview.seat.runAs, '--', 'kill', `-${signal}`, '--', `-${group}`],
        {
          cwd: '/',
          stdio: 'ignore',
        },
      ).on('error', () => undefined)
      return
    }
    try {
      process.kill(-group, signal === 'TERM' ? 'SIGTERM' : 'SIGKILL')
    } catch {
      // already gone
    }
  }

  private append(preview: Preview, text: string) {
    const lines = (preview.partial + text.replace(ANSI, '')).split('\n')
    preview.partial = lines.pop() ?? ''
    for (const line of lines) preview.lines.push(hide(preview, line).slice(0, LINE_MAX))
    if (preview.info.step === 'setup' && lines.some((line) => line.startsWith(APP_STARTS))) {
      preview.info = { ...preview.info, step: 'app' }
      this.report(preview)
    }
    preview.written += lines.length
    if (preview.lines.length > PREVIEW_LOG_LINES)
      preview.lines.splice(0, preview.lines.length - PREVIEW_LOG_LINES)
  }

  private tail(preview: Preview, lines = PREVIEW_LOG_LINES) {
    const all = preview.partial ? [...preview.lines, hide(preview, preview.partial)] : preview.lines
    return all.slice(-lines).join('\n')
  }

  /**
   * Who holds a port: another thread's preview here, or on a member's machine
   * whatever listens on it (port-holders.ts); `own` when it is the thread's.
   * Null in a thread's own network, where only the thread's processes can.
   */
  private async heldBy(port: number, seat: Seat, net: ThreadNet | null) {
    if (net) return null
    const owner = [...this.previews.values()].find((p) =>
      [p.info.port, ...p.info.ports].includes(port),
    )
    if (owner)
      return {
        text: `another thread's preview${owner.info.repository ? ` of ${owner.info.repository}` : ''}`,
        own: false,
      }
    if (CLOUD) return null
    const held = await whoHolds(port, seat.sessionId)
    return held && { text: held.text, own: holderOwner(held.holder, seat.sessionId) === 'thread' }
  }

  /** On a member's machine, the ports the log says were taken, with who holds each; '' for none. */
  private async takenSaid(preview: Preview) {
    if (CLOUD) return ''
    const said: string[] = []
    for (const port of takenPorts(this.tail(preview, 80))) {
      const held = await whoHolds(port, preview.seat.sessionId).catch(() => null)
      if (!held) continue
      said.push(`port ${port} is held by ${held.text}`)
      this.append(preview, `[preview] Port ${port} is held by ${held.text}\n`)
    }
    return said.length ? `: ${said.join('; ')}` : ''
  }

  private ended(preview: Preview, status: 'failed' | 'stopped', reason: string) {
    this.previews.delete(preview.seat.sessionId)
    preview.proxy.close()
    // A check it was in the middle of says nothing now.
    const { step: _step, check, ...info } = preview.info
    preview.info = {
      ...info,
      ...(check?.status === 'checking' ? {} : check ? { check } : {}),
      status,
      reason,
    }
    this.report(preview)
    if (preview.keptDir) void dropEnvFiles(preview.seat, preview.keptDir)
    void preview.cgroup?.remove()
    if (preview.pausedContainers?.length)
      void this.pause(preview, () => this.unpauseContainers(preview))
  }

  private report(preview: Preview) {
    this.options.emit(preview.seat.sessionId, {
      at: new Date().toISOString(),
      type: 'preview.changed',
      teammateId: preview.seat.teammateId,
      ...preview.info,
    })
  }

  private expire() {
    const now = Date.now()
    for (const [sessionId, preview] of this.previews) {
      // A turn or a person working in the thread uses its preview, through the proxy or not.
      if (this.options.busy?.(sessionId)) preview.lastUsed = now
      const ttl = preview.cgroup ? FROZEN_TTL_MS : TTL_MS
      if (now - preview.lastUsed >= ttl)
        void this.stop(sessionId, `Stopped after ${Math.round(ttl / 60_000)} minutes without use`)
      else if (now - preview.lastUsed >= FREEZE_MS) void this.freeze(preview)
    }
    void this.makeRoom()
  }

  /** The computer runs short of memory or swap: stop the frozen preview unused longest. */
  private async makeRoom() {
    const frozen = [...this.previews.values()].filter((p) => p.frozen)
    if (!frozen.length) return
    const meminfo = await readFile('/proc/meminfo', 'utf8').catch(() => '')
    const kB = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(meminfo)?.[1])
    const swapUsed = kB('SwapTotal') > 0 ? 1 - kB('SwapFree') / kB('SwapTotal') : 0
    if (swapUsed < SWAP_FULL && kB('MemAvailable') / kB('MemTotal') > MEMORY_SHORT) return
    const oldest = frozen.reduce((a, b) => (b.lastUsed < a.lastUsed ? b : a))
    await this.stop(oldest.seat.sessionId, 'Stopped to make room for other previews')
  }
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

/** A line of the app's output with its secrets' values hidden. */
const hide = (preview: Preview, line: string) =>
  preview.hidden.reduce((text, value) => text.split(value).join(HIDDEN), line)

/** A recipe's env with the preview's addresses in place of its placeholders. */
function withAddresses(
  env: Record<string, string>,
  origin: string,
  origins: Record<number, string>,
) {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      value.replace(PLACEHOLDER, (whole, port?: string) =>
        port ? (origins[Number(port)] ?? whole) : origin,
      ),
    ]),
  )
}

/** Run a command as the teammate (or the runner's user), with text on its stdin. */
function runAsUser(args: string[], runAs: string | undefined, input = '') {
  return new Promise<string>((done, fail) => {
    const child = runAs
      ? spawn('sudo', ['-n', '-u', runAs, '--', ...args], { cwd: '/' })
      : spawn(args[0]!, args.slice(1), { cwd: '/' })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')))
    child.on('error', fail)
    child.on('close', (code) =>
      code === 0 ? done(out) : fail(new Error(err.trim() || `${args[0]} exited with ${code}`)),
    )
    // A command that exits without reading its input closes the pipe: not an error.
    child.stdin.on('error', () => undefined)
    child.stdin.end(input)
  })
}

/** A dotenv line: quoted when the value needs it. */
const dotenvLine = (key: string, value: string) =>
  /^[A-Za-z0-9_./:@,+=-]*$/.test(value)
    ? `${key}=${value}`
    : `${key}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`

/**
 * Write a recipe's settings into the app's env file, as the teammate: its
 * variables replaced or added, the file's other lines kept.
 */
async function writeEnvFile(
  dir: string,
  file: string,
  env: Record<string, string>,
  runAs: string | undefined,
) {
  const path = resolve(dir, file)
  const rel = relative(dir, path)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`))
    throw new Error("envFile must be a file inside the preview's directory")
  const before = await runAsUser(['cat', '--', path], runAs).catch(() => '')
  const keys = new Set(Object.keys(env))
  const kept = before
    .split('\n')
    .filter(
      (line) => !keys.has(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1] ?? ''),
    )
  while (kept.length && kept.at(-1) === '') kept.pop()
  const lines = [...kept, ...Object.entries(env).map(([k, v]) => dotenvLine(k, v))]
  await runAsUser(
    ['sh', '-c', 'umask 077 && cat > "$1"', 'sh', path],
    runAs,
    `${lines.join('\n')}\n`,
  )
}

/** Add a file to its checkout's local excludes, unless git already ignores it. */
async function keepOutOfGit(dir: string, file: string, runAs: string | undefined) {
  await runAsUser(
    [
      'sh',
      '-c',
      'cd -- "$1" || exit 0; git check-ignore -q -- "$2" 2>/dev/null && exit 0; ' +
        'ex=$(git rev-parse --git-path info/exclude 2>/dev/null) || exit 0; ' +
        'mkdir -p "$(dirname "$ex")" && printf "/%s%s\\n" "$(git rev-parse --show-prefix)" "$2" >> "$ex"',
      'sh',
      dir,
      file.replace(/^\.\//, ''),
    ],
    runAs,
  ).catch(() => undefined)
}

/** The checkout a directory is in: its root and its repository (from origin). */
async function repositoryOf(dir: string, runAs: string | undefined) {
  try {
    const root = (await runAsUser(['git', '-C', dir, 'rev-parse', '--show-toplevel'], runAs)).trim()
    const remote = await runAsUser(['git', '-C', root, 'remote', 'get-url', 'origin'], runAs)
    const repository = repositoryFromRemote(remote)
    return root && repository ? { root, repository } : null
  } catch {
    return null
  }
}

/** The repositories checked out in the teammate's working directory: each one's directory, relative to it. */
async function checkouts(workDir: string, runAs: string | undefined) {
  const listing = await runAsUser(
    [
      'sh',
      '-c',
      'cd -- "$1" && for d in */; do printf "%s\\t" "${d%/}"; git -C "$d" remote get-url origin 2>/dev/null || echo; done',
      'sh',
      workDir,
    ],
    runAs,
  ).catch(() => '')
  const found: { name: string; repository: string }[] = []
  for (const line of listing.split('\n')) {
    const [name, remote = ''] = line.split('\t')
    const repository = repositoryFromRemote(remote)
    if (name && repository) found.push({ name, repository })
  }
  return found
}

/** The commit a checkout has checked out, or null. */
async function commitOf(dir: string, runAs: string | undefined) {
  return (
    (await runAsUser(['git', '-C', dir, 'rev-parse', 'HEAD'], runAs).catch(() => '')).trim() || null
  )
}

/** How long to wait for the app's port: longer when a setup runs first. */
const waitFor = (input: PreviewStart) =>
  Math.min(
    input.timeoutMs ?? (input.setup ? SETUP_START_MS : PREVIEW_START_MS),
    PREVIEW_START_MAX_MS,
  )

/** A saved recipe as a start, in the checkout (relative to the working directory) it runs in. */
function fromRecipe(recipe: PreviewRecipe, checkout: string, repository: string): PreviewStart {
  return {
    command: recipe.command,
    cwd: recipe.cwd ? `${checkout}/${recipe.cwd}` : checkout,
    port: recipe.port,
    ...(recipe.ports.length ? { ports: recipe.ports } : {}),
    ...(recipe.timeoutSeconds ? { timeoutMs: recipe.timeoutSeconds * 1000 } : {}),
    ...(recipe.setup?.trim() ? { setup: recipe.setup } : {}),
    ...(Object.keys(recipe.env).length ? { env: recipe.env } : {}),
    ...(recipe.envFile ? { envFile: recipe.envFile } : {}),
    paths: recipe.paths,
    repository,
    ...(recipe.passed ? { passed: true } : {}),
    ...(recipe.archive?.trim() ? { archive: recipe.archive } : {}),
  }
}

/**
 * Copy a turn's released env files for one run of a preview, beside the
 * turn's (which go when its harness parks): a restart after a crash, or by a
 * person, still has them while it runs. Removed when it ends.
 */
async function keepEnvFiles(
  seat: Seat,
  files: string[],
): Promise<{ dir?: string; files: string[] }> {
  if (!files.length) return { files: [] }
  const dir = seat.runAs
    ? `${teammateHome(seat.runAs)}/.credentials/preview-${seat.sessionId}-${randomUUID()}`
    : join(HOME, 'credentials', `preview-${seat.sessionId}-${randomUUID()}`)
  const copies = files.map((file, i) => join(dir, `${i}-${file.split('/').pop()}`))
  await runAsUser(
    [
      'sh',
      '-c',
      'umask 077 && mkdir -p -- "$1" && shift && while [ "$#" -gt 1 ]; do cp -- "$1" "$2" && shift 2; done',
      'sh',
      dir,
      ...files.flatMap((file, i) => [file, copies[i]!]),
    ],
    seat.runAs,
  ).catch((error: unknown) => {
    throw new Error(
      `Its credentials are no longer here (${String(error)}): start it again with start_preview`,
    )
  })
  return { dir, files: copies }
}

async function dropEnvFiles(seat: Seat, dir: string) {
  await runAsUser(['rm', '-rf', '--', dir], seat.runAs).catch(() => undefined)
}
