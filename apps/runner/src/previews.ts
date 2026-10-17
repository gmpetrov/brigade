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
// Each start reads the repository's preview variables, which people set, from
// the API: they go into the app's environment over the start's own settings,
// never into what the teammate reads; a secret's value is hidden in the log.
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
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
import { HOME } from './config.js'
import { harnessEnv } from './harness/env.js'
import type { CheckResult } from './preview-check.js'
import { pauseFor, unpause } from './containers.js'
import {
  oomReason,
  PressureWatch,
  PreviewCgroups,
  type Ooms,
  type PreviewCgroup,
} from './preview-cgroup.js'
import { PORTS_PREFIX, PreviewProxy, type ProxyState } from './preview-proxy.js'
import { asTeammate, threadNet, type ThreadNet } from './thread-net.js'
import { containerEnv, teammateHome } from './teammates.js'

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
/** Setup (install, migrate) comes before the app answers: wait longer for it. */
const SETUP_START_MS = 600_000
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
}

/** A saved recipe, and where its repository is checked out in the teammate's directory. */
export type SavedPreview = { recipe: PreviewRecipe; checkout: string }

/** A check of the preview's pages, and what the app logged meanwhile that looks like an error. */
export type PreviewCheck = CheckResult & { serverErrors: string[] }

/** What a teammate's preview tools reach: its thread's preview. */
export type PreviewControl = {
  start(input: PreviewStart, signal?: AbortSignal): Promise<PreviewResult>
  /** Open these paths as a person would and say what is wrong with them. */
  check(paths: string[], signal?: AbortSignal): Promise<PreviewCheck>
  /** Save the running preview as its repository's recipe: once its check passed, or with why what it found is expected. */
  save(reason?: string): Promise<{ repository: string; recipe: PreviewRecipe }>
  /** A repository's saved recipe, and its checkout here; null when none is saved. */
  saved(repository: string): Promise<SavedPreview | null>
  stop(): Promise<{ stopped: boolean }>
  logs(lines?: number): { status: PreviewInfo['status'] | 'none'; logs: string }
}

export type PreviewResult = {
  status: PreviewInfo['status']
  /** Where the app answers for a person, by port, with no token. */
  origins: Record<number, string>
  reason?: string
  logs?: string
  /** The names of the repository's preview variables the app got. */
  variables?: string[]
}

export type Seat = { sessionId: string; teammateId: string; workDir: string; runAs?: string }

/** How a thread's preview last started, to start it again for a person. Credentials are not kept. */
type LastStart = { seat: Seat; input: Omit<PreviewStart, 'envFiles'>; repository?: string }

type Preview = {
  info: PreviewInfo
  seat: Seat
  input: PreviewStart
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

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

export class Previews {
  private previews = new Map<string, Preview>()
  private readonly timer: NodeJS.Timeout
  /** Where previews get cgroups of their own; null where the runner's cgroup is not delegated to it. */
  private readonly cgroups = PreviewCgroups.open()

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
      save: (reason) => this.save(seat, reason),
      saved: (repository) => this.saved(seat, repository),
      stop: async () => ({
        stopped: await this.stop(seat.sessionId, 'Stopped by the teammate'),
      }),
      logs: (lines) => {
        const preview = this.previews.get(seat.sessionId)
        if (preview) preview.lastUsed = Date.now()
        return {
          status: preview?.info.status ?? 'none',
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

  /** The running preview as its repository's recipe, saved through the API. Only once its check passed. */
  async save(seat: Seat, reason?: string) {
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
    }
    await this.options.recipes(seat.sessionId, seat.teammateId, {
      name: 'save',
      repository: found.repository,
      recipe,
    })
    return { repository: found.repository, recipe }
  }

  /** A repository's saved recipe, and the directory it is checked out in here. */
  async saved(seat: Seat, name: string): Promise<SavedPreview | null> {
    const repository = name.toLowerCase()
    const recipe = await this.recipe(seat, repository)
    if (!recipe) return null
    const checkout = (await checkouts(seat.workDir, seat.runAs)).find(
      (c) => c.repository === repository,
    )?.name
    if (!checkout)
      throw new Error(
        `${repository} has a saved preview, but it is not checked out here: check it out with checkout_repository first`,
      )
    return { recipe, checkout }
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

  private async start(seat: Seat, input: PreviewStart, signal?: AbortSignal) {
    const { preview, origins } = await this.begin(seat, input)
    await this.untilReady(preview, waitFor(preview.input), signal)

    const result: PreviewResult = { status: preview.info.status, origins }
    if (preview.info.reason) result.reason = preview.info.reason
    if (preview.variables.length) result.variables = preview.variables
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
        const recipe = await this.recipe(seat, checkout.repository)
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
    // Taken (another thread's preview of the same app): a command reading $PORT gets a free one.
    if (PORT_VARIABLE.test(command) && (await answers(input.port, host))) {
      for (let port = input.port + 1; port < input.port + 100 && port <= 65535; port++) {
        if (others.includes(port) || (await answers(port, host))) continue
        input = { ...input, port }
        break
      }
    }
    const ports = [...new Set(others.filter((p) => p !== input.port))]
    const all = [input.port, ...ports]
    for (const port of all) {
      if (!(await answers(port, host))) continue
      const owner = net
        ? undefined
        : [...this.previews.values()].find((p) => [p.info.port, ...p.info.ports].includes(port))
      throw new Error(
        owner
          ? `Port ${port} is in use by another thread's preview${owner.info.repository ? ` of ${owner.info.repository}` : ''}. ` +
              'Stop that preview, or write the command with $PORT (e.g. "pnpm dev --port $PORT"): then it gets a free port.'
          : `Port ${port} is already in use ${net ? 'in this thread' : 'on this computer'}, by a process you started. Stop that process, ` +
              'or write the command with $PORT (e.g. "pnpm dev --port $PORT"): then it gets a free port.',
      )
    }

    const checkout = await repositoryOf(dir, seat.runAs)
    const repository = input.repository?.toLowerCase() ?? checkout?.repository
    const variables = repository ? await this.variables(seat, repository) : { env: {}, secrets: [] }

    // The proxy is what people reach: its port is the one hosted, the app's other ports are paths on it.
    let preview: Preview | undefined
    const proxyOptions = {
      ...(host ? { host } : {}),
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
        : {}),
      PORT: String(input.port),
      // Reachable from the proxy whatever address it binds; 0.0.0.0 also suits a member's machine.
      HOST: '0.0.0.0',
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
    // The wrapper prints its pid first, to find its group. With a cgroup of its own it then
    // waits to be moved in, so that all it starts is in there, and offers itself first to the
    // kernel's OOM killer should the whole computer run out.
    const script = cgroup
      ? 'cd -- "$0" || exit 1; echo "$$"; read -r _; { echo 500 >/proc/self/oom_score_adj; } 2>/dev/null; exec sh -c "$1" </dev/null'
      : 'cd -- "$0" || exit 1; echo "$$"; exec sh -c "$1" </dev/null'
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
    const options = {
      cwd: '/',
      env: preview.env,
      // stdin: the wrapper's go once it is in its cgroup (ended at once without one); the app's is /dev/null.
      stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
      detached: true,
    }
    const child = runAs
      ? spawn(
          asTeammate(runAs, preview.net ?? null).file,
          [
            ...asTeammate(runAs, preview.net ?? null).args,
            'sh',
            '-c',
            script,
            preview.dir,
            command,
          ],
          options,
        )
      : spawn('sh', ['-c', script, preview.dir, command], options)
    preview.child = child
    delete preview.group
    preview.exited = new Promise((done) => {
      child.once('error', () => done(null))
      child.once('close', (code) => done(code))
    })
    child.stdin.on('error', () => undefined)
    if (!cgroup) child.stdin.end()

    let pidLine = true
    child.stdout.on('data', (data: Buffer) => {
      let text = data.toString('utf8')
      if (pidLine) {
        const newline = text.indexOf('\n')
        if (newline < 0) return
        pidLine = false
        const pid = Number(text.slice(0, newline))
        if (cgroup) void this.enter(preview, cgroup, pid).finally(() => child.stdin.end('\n'))
        void this.findGroup(preview, pid)
        text = text.slice(newline + 1)
      }
      this.append(preview, text)
    })
    child.stderr.on('data', (data: Buffer) => this.append(preview, data.toString('utf8')))
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
      this.ended(preview, 'failed', ran ? `The app stopped: it ${how}` : `The command ${how}`)
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

  /** Wait for the app's port to answer, its process to end, or the time to run out. */
  private async untilReady(preview: Preview, waitMs: number, signal?: AbortSignal) {
    const { sessionId } = preview.seat
    const deadline = Date.now() + waitMs
    while (this.previews.get(sessionId) === preview && preview.info.status === 'starting') {
      if (await answers(preview.input.port, preview.net?.address)) {
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

  private async findGroup(preview: Preview, pid: number) {
    if (!Number.isInteger(pid) || pid <= 0) return
    if (!preview.seat.runAs) {
      // Detached: the wrapper leads its own group.
      preview.group = pid
      return
    }
    // Under sudo the wrapper is in sudo's group, or its own session when sudo uses a pty.
    const { stdout } = await run('ps', ['-o', 'pgid=', '-p', String(pid)], { cwd: '/' }).catch(
      () => ({ stdout: '' }),
    )
    const group = Number(stdout.trim())
    preview.group = group > 0 ? group : pid
    if (preview.stopping) this.kill(preview, 'TERM')
  }

  /** Move the wrapper into the preview's cgroup, before it starts the command. */
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
    const status = stalled.info.status === 'running' ? 'The app stopped' : 'The command stopped'
    stalled.stopping = {
      status: 'failed',
      reason:
        `${status}: it was stuck waiting for memory for ${Math.round(this.pressure.duration / 1000)} s, ` +
        `with ${(memory / 1024 ** 3).toFixed(1)} GB in use`,
    }
    this.append(stalled, `[preview] ${stalled.stopping.reason}\n`)
    this.kill(stalled, 'KILL')
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

/** owner/name from a remote URL: GitHub's, or the API's git proxy, which ends the same way. */
export function repositoryFromRemote(url: string) {
  const match = /[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim())
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null
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
