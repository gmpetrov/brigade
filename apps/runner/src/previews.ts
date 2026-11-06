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
// killed alone, with the reason, when it takes too much memory. On a member's
// machine its process group stops (SIGSTOP) instead, with its thread's Compose
// containers, until the next request; it stops after TTL_MS as before.
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
// .worktreeinclude names from the member's own clone (its .env). People open it
// at a name of the thread's own, <thread>.localhost (localName): a browser keeps
// cookies by name, not port, so on plain localhost one thread's preview would
// sign another's out.
//
// Each start reads the repository's preview variables, which people set, from
// the API: they go into the app's environment over the start's own settings,
// never into what the teammate reads; a secret's value is hidden in the log.
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import { createConnection } from 'node:net'
import { uptime } from 'node:os'
import { dirname, extname, join, posix, relative, resolve, sep } from 'node:path'
import type { Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  PREVIEW_LOG_LINES,
  PREVIEW_REPLACED,
  type AgentEvent,
  type PreviewInfo,
  type PreviewMachineAccess,
  type PreviewMachineUp,
  type PreviewOperation,
  type PreviewRecipe,
  type PreviewStartOutcome,
} from '@brigade/contracts'
import { CLOUD, HOME } from './config.js'
import { harnessEnv } from './harness/env.js'
import type { CheckResult } from './preview-check.js'
import { pauseFor, pauseMember, unpause, unpauseMember } from './containers.js'
import {
  oomReason,
  PressureWatch,
  PreviewCgroup,
  runnerCgroups,
  type Ooms,
} from './preview-cgroup.js'
import {
  appState,
  clearRun,
  MachineLink,
  MachineSync,
  machineKey,
  READER,
  readOutput,
  REMOTE_WORK,
  remoteScript,
  signalApp,
  startApp,
  writeRun,
} from './preview-machine.js'
import {
  PORTS_PREFIX,
  PreviewProxy,
  type PreviewProxyOptions,
  type ProxyState,
} from './preview-proxy.js'
import type { Candidate } from './memory-guard.js'
import { processes, processGroups } from './process-groups.js'
import { runAsUser } from './run-as.js'
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
 * stops after FROZEN_TTL_MS, or sooner when the computer runs short. On a
 * member's machine its processes stop (SIGSTOP) until the next request, and it
 * stops after TTL_MS: macOS compresses or swaps what they hold.
 */
const FREEZE_MS = Number(process.env.BRIGADE_PREVIEW_FREEZE_MS) || 5 * 60_000
const FROZEN_TTL_MS = Number(process.env.BRIGADE_PREVIEW_FROZEN_TTL_MS) || 4 * 60 * 60_000
/**
 * A preview on a machine of its own (preview-machine.ts) sleeps after this long without use: the
 * app and its machine stop, costing nothing, and the next request wakes them, in about half a
 * minute. Later than FREEZE_MS: waking a machine takes longer than thawing a frozen preview.
 */
const SLEEP_MS = Number(process.env.BRIGADE_PREVIEW_SLEEP_MS) || 30 * 60_000
/** While it is up, the API is told this often that a preview's machine is in use. */
const TOUCH_MS = 5 * 60_000
/** Longest a stop waits for a launch on the machine to give up (one SSH step, at most). */
const REMOTE_STEP_MS = 20_000
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
/** How often the app's output file is read. */
const OUTPUT_POLL_MS = 250
/** The app's output file is emptied past this, once read: a dev server's log grows for hours. */
const OUTPUT_MAX = 16 * 1024 ** 2
/** A hand-over older than this is from another restart: what it names is not ours to take up. */
const HANDED_FRESH_MS = 10 * 60_000
/**
 * What runs the app on this computer, as the runner's user: it leads the app's process group, and
 * notes how the app ended ($0), since a runner after this one cannot wait for its end. With a
 * cgroup ($1 = 1) it first waits on fd 3 until the runner moved it in, so all the app starts is in
 * there from the start. Its output goes to a file the runner gives it, not a pipe: it outlives the
 * runner, and the next one reads on from where this one was (handOver, adopt).
 */
const WRAPPER =
  '[ "$1" = 1 ] && read -r _ <&3; shift; "$@" 3<&-; c=$?; ' +
  'echo "$c" > "$0.tmp" && mv -f "$0.tmp" "$0"; exit "$c"'

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
  logs(lines?: number): Promise<{
    status: PreviewInfo['status'] | 'none'
    /** Where the app answers for a person, by port, while it runs: to test on it. */
    origins?: Record<number, string>
    /**
     * On a cloud computer, the preview's address with an access token for a few minutes: open
     * it first in a browser, which it lets in to `origins` for this run. They alone answer 403.
     */
    open?: string
    logs: string
  }>
}

export type PreviewResult = {
  status: PreviewInfo['status']
  /** Where the app answers for a person, by port, with no token. */
  origins: Record<number, string>
  /**
   * On a cloud computer, the preview's address with an access token for a few minutes: open
   * it first in a browser, which it lets in to `origins` for this run. They alone answer 403.
   */
  open?: string
  reason?: string
  logs?: string
  /** The names of the repository's preview variables the app got. */
  variables?: string[]
  /** What the start changed, for the teammate: a port something else holds, and the one it got instead. */
  notes?: string[]
}

export type Seat = { sessionId: string; teammateId: string; workDir: string; runAs?: string }

/**
 * Previews on a machine of their own (the preview_machines feature, preview-machine.ts): the
 * thread's machine through the API, and the runner's folder for its key and SSH files.
 */
export type MachineOptions = {
  /** The thread's machine, running, with this key let in; { machine: null }: the preview runs here. */
  up: (sessionId: string, publicKey: string) => Promise<PreviewMachineUp>
  /** Nobody used it for a while, or it stopped: its machine stops, its disk kept. */
  sleep: (sessionId: string) => Promise<unknown>
  /** Still in use: its machine is not stopped meanwhile. */
  touch: (sessionId: string) => Promise<unknown>
  home: string
}

/** A preview on a machine of its own: how the runner reaches it, and its copy of the code there. */
type Remote = {
  link: MachineLink
  sync: MachineSync
  /** The app's folder on the machine, relative to its user's home. */
  dir: string
  /** What the app is given there: its own settings, never this computer's environment. */
  env: Record<string, string>
  /** Asleep: the app and its machine stopped while nobody used it; the next request wakes them. */
  asleep?: boolean
  /** Its machine being stopped: a wake waits for that first, or the stop would land after it. */
  sleeping?: Promise<unknown>
  waking?: Promise<void>
  /** When the API was last told it is in use. */
  touchedAt: number
  /** It ends with its machine left running: another start takes it on (a replacement, an update). */
  keepAwake?: boolean
  /** Its launch on the machine while under way: a stop waits for it to give up. */
  launching?: Promise<void>
  /** Its lines in the preview's log. */
  log: (line: string) => void
  /** The checkout sent there, and the files git ignores that go too: for a runner after this one. */
  root: string
  includes: string[]
}

/**
 * One run of the app, detached: its output in a file this runner reads as it grows, so the app
 * outlives the runner and an update hands it over (handOver), the next runner reading on (adopt).
 */
type AppRun = {
  /** On this computer: the shell leading its process group, which notes how the app ended. */
  pid?: number
  /** When it started: that shell is known again by it (a pid is given out again once free). */
  at: number
  /** Bytes of its output read so far, and to the end of its last whole line. */
  offset: number
  lineOffset: number
  decoder: StringDecoder
  /** Followed by this runner: no longer once handed over, asleep or killed. */
  following: boolean
  /** Stop following it, leaving the app as it is: what waits for its end hears null. */
  stopFollowing: () => void
  /** On its machine: the connection reading its output now. */
  follower?: ChildProcess
  /** On its machine: its connection was lost, and could not be made again. */
  lost?: boolean
}

/** A preview the runner before this one handed over (handOver), for this one to take up (adopt). */
type Handed = {
  seat: Seat
  input: Omit<PreviewStart, 'envFiles'>
  info: PreviewInfo
  origins: Record<number, string>
  dir: string
  group?: number
  net?: ThreadNet
  /** Its cgroup's path. */
  cgroup?: string
  ooms?: Ooms
  frozen?: boolean
  pausedContainers?: string[]
  envFiles: string[]
  keptDir?: string
  checked?: boolean
  variables: string[]
  /** The repository's variables that are settings, with their values; its secrets, by name only. */
  settings: Record<string, string>
  secrets: string[]
  restarts: number[]
  lastUsed: number
  /** Its log as people saw it (secrets already hidden), and the lines written in all. */
  lines: string[]
  written: number
  /** Its run: from `offset` on, its output is still to be read (the next whole line's start). */
  run: { pid?: number; at: number; offset: number }
  remote?: {
    access: PreviewMachineAccess
    dir: string
    root: string
    includes: string[]
    asleep?: boolean
  }
}

/** What a runner hands over to the next: when, on which boot of the computer, and its previews. */
type HandOver = { at: number; boot: number; previews: Handed[] }

/** How a thread's preview last started, to start it again for a person. Credentials are not kept. */
type LastStart = { seat: Seat; input: Omit<PreviewStart, 'envFiles'>; repository?: string }

type Preview = {
  info: PreviewInfo
  seat: Seat
  input: PreviewStart
  /** Where the app answers for a person, by port, with no token. */
  origins: Record<number, string>
  /** Its app's latest run; unset only until the first launch. */
  run?: AppRun
  proxy: PreviewProxy
  /** The app stopped and starts again: when it did, for RESTART_DELAYS_MS. */
  restarts: number[]
  restarting?: boolean
  /** The command's environment, for a restart; unset when a runner after an update could not make it again. */
  env?: NodeJS.ProcessEnv
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
  /** Those that are settings, with their values, and the secrets' names: for a runner after an update. */
  settings: Record<string, string>
  secretNames: string[]
  /** Its secrets' values are not known (a runner after an update could not read them): its output is not shown. */
  blind?: boolean
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
  /** On a machine of its own, not on this computer. */
  remote?: Remote
  /** Taken up after an update: once its environment is made again (a wake waits for it). */
  ready?: Promise<void>
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

/** Once `work` is over, or `ms` passed, whichever comes first (its timer then cleared). */
async function within(work: Promise<unknown>, ms: number) {
  let timer: NodeJS.Timeout | undefined
  await Promise.race([work, new Promise((done) => (timer = setTimeout(done, ms)))])
  clearTimeout(timer)
}

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
      /**
       * Previews on a machine of their own, for threads whose starter chose them: unset where
       * previews always run on this computer (a member's own machine).
       */
      machines?: MachineOptions
    },
  ) {
    this.timer = setInterval(() => this.expire(), 60_000)
    this.timer.unref()
    this.pressureTimer = setInterval(() => void this.watchPressure(), 5_000)
    this.pressureTimer.unref()
    this.pausedFile = join(dirname(options.stateFile), 'paused-containers.json')
    this.unresumed = readPaused(this.pausedFile)
    // The previews the runner before this one handed over, taken up by adopt(): their paused
    // containers stay paused, theirs to resume.
    this.handed = readHandOver(this.handOverFile)
    rmSync(this.handOverFile, { force: true })
    const handedPaused = new Set(
      this.handed.flatMap((p) => (p.pausedContainers ? [`${p.seat.sessionId}:${p.pausedContainers.join(',')}`] : [])),
    )
    this.unresumed = this.unresumed.filter(([, sessionId, ids]) => !handedPaused.has(`${sessionId}:${ids.join(',')}`))
    void this.resumeLeft()
    try {
      const saved = JSON.parse(readFileSync(options.stateFile, 'utf8')) as [string, LastStart][]
      this.lastStarts = new Map(saved)
    } catch {
      // None yet.
    }
  }

  private lastStarts = new Map<string, LastStart>()
  /** The runner is handing its previews over to the next one (handOver): nothing more starts or stops. */
  private handedOver = false
  /** Handed over by the runner before this one, until adopt() takes them up. */
  private handed: Handed[] = []
  /** Taken up, until startAgain finishes it once connected: whether their first part went well. */
  private adopting: {
    preview: Preview
    saved: Handed
    ready: Promise<string | undefined>
    settle: () => void
  }[] = []
  /**
   * What is under way on each thread's machine (a launch, a stop, a sleep), the last of it: one
   * thing at a time on a machine, so a launch a stop cut short, or the cleanup of the preview a
   * new one replaces, never acts on the machine once the next one's launch has begun there.
   */
  private readonly machineWork = new Map<string, Promise<void>>()
  private readonly pressureTimer: NodeJS.Timeout
  private readonly pressure = new PressureWatch<Preview>()
  /** Containers paused for frozen previews, by user: unpaused at the next start should the runner stop first. */
  private readonly pausedFile: string
  /**
   * Containers paused for previews that are not resumed yet: the runner before this one's, and
   * those Docker did not resume when asked. Tried again each minute, kept in pausedFile meanwhile.
   */
  private unresumed: Paused[] = []
  private resuming?: Promise<void>
  /** Those of unresumed Docker is being asked to resume right now. */
  private readonly trying = new Set<Paused>()

  /** Previews running or starting, frozen ones aside: nobody is using those. */
  get count() {
    return [...this.previews.values()].filter((p) => !p.frozen && !p.remote?.asleep).length
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
      logs: async (lines) => {
        const preview = this.previews.get(seat.sessionId)
        if (preview) preview.lastUsed = Date.now()
        const running = preview?.info.status === 'running'
        const open = running ? await this.openUrl(preview) : undefined
        return {
          status: preview?.info.status ?? 'none',
          ...(running ? { origins: preview.origins } : {}),
          ...(open ? { open } : {}),
          logs: preview ? this.tail(preview, lines) : '',
        }
      },
    }
  }

  /**
   * The address a browser opens first on a cloud computer: the preview gateway lets in only
   * whoever comes with an access token. None on a member's own machine, where it is localhost.
   */
  private async openUrl(preview: Preview) {
    if (!this.options.viewUrl) return undefined
    return this.options
      .viewUrl(preview.seat.sessionId, preview.info.publicPort ?? preview.info.port)
      .catch((error: unknown) => {
        console.warn(`no address with a token for ${preview.seat.sessionId}: ${String(error)}`)
        return undefined
      })
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

  /** Where people open the thread's preview, without a token. */
  origin(sessionId: string) {
    const preview = this.previews.get(sessionId)
    return preview?.origins[preview.input.port]
  }

  /**
   * Open the preview's pages with the computer's Chrome, at the address people
   * open, as the teammate; screenshots go in .preview-checks in its directory.
   */
  async check(seat: Seat, paths: string[], signal?: AbortSignal): Promise<PreviewCheck> {
    const asleep = this.previews.get(seat.sessionId)
    // Asleep on its machine: woken first, as a person's visit would.
    if (asleep?.remote && (asleep.remote.asleep || asleep.remote.waking)) await this.wake(asleep)
    const preview = this.previews.get(seat.sessionId)
    // On its machine: checked once the latest changes are there.
    await preview?.remote?.sync.flush().catch(() => undefined)
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
      : preview.origins[preview.input.port]!
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
    // A launch on its machine under way gives up at its next step: waited for, so it is over
    // before anything takes its place there (a replacement's launch waits for it too).
    if (preview.remote?.launching) await within(preview.remote.launching, REMOTE_STEP_MS)
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
   * The runner restarts into an update: its previews go on, for the next runner to take up where
   * they are (adopt). Each app keeps running (its process group, its cgroup, its containers, its
   * database), frozen or not, its output going on into its file; on its machine, it runs detached
   * there. Only the proxy in front of it stops, for a few seconds: the next runner listens again
   * on its port. One it cannot hand over (starting again after a crash, waking its machine) stops,
   * and the next runner starts it again as it last started (startAgain), unless it needs the
   * vault's credentials, which only its teammate can release, or nobody was using it (frozen).
   */
  async handOver() {
    // Nothing starts, restarts, freezes or stops on its own from now on: what is under way ends.
    this.handedOver = true
    await Promise.all(
      [...this.previews.values()].map(async (preview) => {
        await within(preview.pausing, REMOTE_STEP_MS)
        const work = this.machineWork.get(preview.seat.sessionId)
        if (work) await within(work, REMOTE_STEP_MS)
      }),
    )
    const handed: Handed[] = []
    for (const preview of [...this.previews.values()]) {
      const saved = this.handable(preview)
      if (!saved) continue
      handed.push(saved)
      // Its app goes on: only this runner's hold on it ends.
      this.previews.delete(preview.seat.sessionId)
      preview.run?.stopFollowing()
      preview.proxy.close()
      if (preview.remote) {
        preview.remote.sync.stop()
        preview.remote.link.close()
      }
      // Noted for the next runner too, which resumes them should it not take the preview up.
      if (preview.pausedContainers?.length)
        this.unresumed.push([
          preview.seat.runAs ?? '',
          preview.seat.sessionId,
          preview.pausedContainers,
        ])
    }
    this.savePaused()
    try {
      mkdirSync(dirname(this.handOverFile), { recursive: true })
      const temp = `${this.handOverFile}.tmp`
      writeFileSync(
        temp,
        JSON.stringify({ at: Date.now(), boot: bootTime(), previews: handed } satisfies HandOver),
        { mode: 0o600 },
      )
      renameSync(temp, this.handOverFile)
    } catch (error) {
      console.warn(`could not note the previews handed over: ${String(error)}`)
    }
    if (handed.length) console.log(`handed over ${handed.length} preview(s) to the next runner`)

    const again = [...this.previews.values()].flatMap((p) => {
      const last = this.lastStarts.get(p.seat.sessionId)
      return !p.frozen && last && !last.input.credentials?.length ? [p.seat.sessionId] : []
    })
    try {
      writeFileSync(this.againFile, JSON.stringify(again), { mode: 0o600 })
    } catch (error) {
      console.warn(`could not note the previews to start again: ${String(error)}`)
    }
    // Those the next runner starts again keep their machines up for it.
    for (const id of again) {
      const remote = this.previews.get(id)?.remote
      if (remote) remote.keepAwake = true
    }
    await Promise.all(
      [...this.previews.keys()].map((id) =>
        this.stop(
          id,
          again.includes(id)
            ? 'Brigade updated on this computer: the preview starts again in a moment'
            : 'The computer updated Brigade',
        ),
      ),
    )
  }

  /** What the next runner needs to take a preview up; null when it cannot be handed over as it is. */
  private handable(preview: Preview): Handed | null {
    const { run, remote } = preview
    if (preview.stopping || preview.restarting) return null
    if (preview.info.status !== 'running' && preview.info.status !== 'starting') return null
    // Asleep, nothing of it runs: the next request wakes it, as here.
    const asleep = remote?.asleep === true
    if (!asleep && (!run?.following || remote?.waking)) return null
    if (!remote && !run?.pid) return null
    const { check, ...info } = preview.info
    return {
      seat: preview.seat,
      input: (({ envFiles: _envFiles, ...input }) => input)(preview.input),
      // A check under way says nothing once its runner is gone.
      info: check && check.status !== 'checking' ? { ...info, check } : info,
      origins: preview.origins,
      dir: preview.dir,
      ...(preview.group ? { group: preview.group } : {}),
      ...(preview.net ? { net: preview.net } : {}),
      ...(preview.cgroup ? { cgroup: preview.cgroup.path } : {}),
      ...(preview.ooms ? { ooms: preview.ooms } : {}),
      ...(preview.frozen ? { frozen: true } : {}),
      ...(preview.pausedContainers?.length ? { pausedContainers: preview.pausedContainers } : {}),
      envFiles: preview.envFiles,
      ...(preview.keptDir ? { keptDir: preview.keptDir } : {}),
      ...(preview.checked !== undefined ? { checked: preview.checked } : {}),
      variables: preview.variables,
      settings: preview.settings,
      secrets: preview.secretNames,
      restarts: preview.restarts,
      lastUsed: preview.lastUsed,
      lines: preview.lines,
      written: preview.written,
      // From the start of the line it has not finished: read again, whole, by the next runner.
      run: { ...(run?.pid ? { pid: run.pid } : {}), at: run?.at ?? 0, offset: run?.lineOffset ?? 0 },
      ...(remote
        ? {
            remote: {
              access: remote.link.machine,
              dir: remote.dir,
              root: remote.root,
              includes: remote.includes,
              ...(asleep ? { asleep: true } : {}),
            },
          }
        : {}),
    }
  }

  /** The groups of the apps the runner before this one handed over: kept, not stopped as leftovers. */
  static handedOverGroups(stateFile: string): number[] {
    return readHandOver(join(dirname(stateFile), 'previews-handed.json')).flatMap((p) =>
      p.group ? [p.group] : [],
    )
  }

  /**
   * Take up the previews the runner before this one handed over (handOver), before anything
   * looks for what it left running: each app goes on where it is, frozen or asleep as it was,
   * its proxy listening again on its port, at the same addresses, its log read on from where it
   * was. Those whose app is gone start again once connected (startAgain), and say why. Called
   * once, right after the runner starts; what needs the API (a machine, secrets) waits for it.
   */
  adopt() {
    const handed = this.handed
    this.handed = []
    for (const saved of handed) {
      if (this.previews.has(saved.seat.sessionId)) continue
      const preview = this.fromHanded(saved)
      this.previews.set(saved.seat.sessionId, preview)
      let settle!: () => void
      preview.ready = new Promise<void>((done) => (settle = done))
      const ready = this.takeUp(preview, saved, settle).catch((error: unknown) => {
        console.warn(`could not take up the preview of ${saved.seat.sessionId}: ${String(error)}`)
        return `it could not be taken up (${error instanceof Error ? error.message : String(error)})`
      })
      this.adopting.push({ preview, saved, ready, settle })
    }
    return Promise.all(this.adopting.map((a) => a.ready))
  }

  /** A preview as the runner before this one had it, not taken up yet. */
  private fromHanded(saved: Handed): Preview {
    let preview: Preview | undefined
    const { seat, info, remote: away } = saved
    const host = away ? '127.0.0.1' : saved.net?.address
    const options = this.proxyOptions(() => preview, { host, port: info.port, ports: info.ports })
    behind(options, saved.origins[info.port]!)
    const remote =
      away && this.options.machines
        ? this.remoteFor(
            seat,
            saved.net ?? null,
            this.linkFor(away.access, join(this.options.machines.home, 'preview-machines', 'id_ed25519')),
            saved.dir,
            away.root,
            away.includes,
          )
        : undefined
    if (remote) {
      remote.asleep = away?.asleep === true
      remote.log = (line) => this.append(preview!, `${line}\n`)
    }
    preview = {
      info,
      seat,
      input: { ...saved.input, ...(saved.envFiles.length ? { envFiles: saved.envFiles } : {}) },
      origins: saved.origins,
      proxy: new PreviewProxy(options),
      restarts: saved.restarts,
      dir: saved.dir,
      ...(saved.group ? { group: saved.group } : {}),
      ...(saved.net ? { net: saved.net } : {}),
      ...(saved.cgroup ? { cgroup: new PreviewCgroup(saved.cgroup) } : {}),
      ...(saved.ooms ? { ooms: saved.ooms } : {}),
      ...(saved.frozen ? { frozen: true } : {}),
      ...(saved.pausedContainers ? { pausedContainers: saved.pausedContainers } : {}),
      pausing: Promise.resolve(),
      envFiles: saved.envFiles,
      ...(saved.keptDir ? { keptDir: saved.keptDir } : {}),
      ...(saved.checked !== undefined ? { checked: saved.checked } : {}),
      variables: saved.variables,
      hidden: [],
      settings: saved.settings,
      secretNames: saved.secrets,
      lines: saved.lines,
      written: saved.written,
      partial: '',
      lastUsed: saved.lastUsed,
      exited: new Promise(() => undefined),
      notes: [],
      ...(remote ? { remote } : {}),
    }
    return preview
  }

  /**
   * Its first part, without the API: whether its app still runs, its proxy on its port, and on
   * this computer its log read on (once its secrets are known: those need the API). Resolves to
   * why it cannot be taken up, if so.
   */
  private async takeUp(
    preview: Preview,
    saved: Handed,
    settle: () => void,
  ): Promise<string | undefined> {
    const { sessionId } = preview.seat
    if (!preview.remote) {
      if (saved.remote) return 'this runner runs no previews on machines'
      const files = this.runFiles(preview)
      const running =
        !existsSync(files.exit) &&
        (!saved.cgroup || existsSync(saved.cgroup)) &&
        (await leads(saved.run.pid, saved.run.at))
      if (!running) {
        preview.exited = Promise.resolve(exitStatus(files.exit))
        return 'its app stopped while Brigade updated'
      }
    }
    await preview.proxy.listenAt(preview.info.publicPort ?? preview.info.port)
    if (this.previews.get(sessionId) !== preview) return undefined
    // Said again by this runner: the API takes a preview its runner's previous process reported as lost.
    this.report(preview)
    console.log(`took up the preview of ${sessionId} after the update`)
    // On its machine, or with secrets: once connected (startAgain).
    if (saved.secrets.length || (preview.remote && !preview.remote.asleep)) return undefined
    await this.goOn(preview, saved, { env: saved.settings, secrets: [] })
    settle()
    return undefined
  }

  /**
   * Its last part, once its secrets' values are known (`variables`; null when they could not be
   * read: its output is then not shown, and it is not started again after a crash): its
   * environment for a restart, then on this computer its log read on, and on its machine its
   * connection, forwards, sync and log there. An app started without a turn and not ready yet is
   * checked once it answers, as it would have been.
   */
  private async goOn(
    preview: Preview,
    saved: Handed,
    variables: { env: Record<string, string>; secrets: string[] } | null,
  ) {
    const current = () => this.previews.get(preview.seat.sessionId) === preview && !preview.stopping
    if (variables) {
      preview.hidden = hiddenValues(variables)
      const { env, remoteEnv } = await appEnv(
        preview.seat,
        preview.input,
        preview.info.ports,
        preview.origins,
        variables.env,
      )
      preview.env = env
      if (preview.remote) preview.remote.env = remoteEnv
    } else {
      preview.blind = true
      this.append(
        preview,
        '[preview] Its output after the update is not shown: its secret variables could not be read again\n',
      )
    }
    if (!current()) return
    const run = this.newRun(saved.run.pid, saved.run.offset)
    run.at = saved.run.at
    if (preview.remote) {
      if (!preview.remote.asleep) {
        const why = await this.onMachineNow(preview.seat.sessionId, () =>
          this.reconnect(preview, preview.remote!, run),
        )
        if (why) return why
      }
    } else {
      preview.run = run
      this.followLocal(preview, run)
    }
    if (preview.info.status === 'starting')
      void this.untilReady(preview, Math.max(60_000, waitFor(preview.input, !!preview.remote)))
        .then(() =>
          this.previews.get(preview.seat.sessionId) === preview && preview.info.status === 'running'
            ? this.check(preview.seat, []).then(() => undefined)
            : undefined,
        )
        .catch((error: unknown) =>
          this.append(preview, `[preview] Its pages could not be checked: ${String(error)}\n`),
        )
    return undefined
  }

  /** Back on its machine after an update: up for this runner, connected, its app still running there. */
  private async reconnect(preview: Preview, remote: Remote, run: AppRun) {
    const machines = this.options.machines!
    const key = await machineKey(machines.home)
    // Held for the preview again here, so a command ending there does not stop the machine.
    const answer = await machines.up(preview.seat.sessionId, key.publicKey)
    if (!answer.machine) return `its machine is not available (${answer.reason ?? 'none given'})`
    remote.link.update(answer.machine)
    await remote.link.connect()
    const state = await appState(remote.link)
    if (state?.state !== 'running') return 'its app stopped on its machine while Brigade updated'
    if (this.previews.get(preview.seat.sessionId) !== preview || preview.stopping) return undefined
    for (const port of [preview.input.port, ...preview.info.ports]) await remote.link.forward(port)
    remote.touchedAt = Date.now()
    this.followRemote(preview, remote, run)
    void remote.sync.flush().then(
      () => remote.log('[preview] Its machine has the code; changes go as they happen'),
      (error: unknown) => remote.log(`[preview] The sync with its machine did not start: ${String(error)}`),
    )
    return undefined
  }

  /** Work on a thread's machine, one thing at a time there, resolving to what it resolves to. */
  private onMachineNow<T>(sessionId: string, work: () => Promise<T>) {
    let result: T | undefined
    let failed: unknown
    return this.onMachine(sessionId, async () => {
      try {
        result = await work()
      } catch (error) {
        failed = error
      }
    }).then(() => {
      if (failed !== undefined) throw failed
      return result
    })
  }

  /**
   * After an update, once connected: the previews taken up go on (their secrets read, their
   * machines reached), those whose app is gone start again and say why; then those the runner
   * before stopped as it could not hand them over start again too (handOver).
   */
  async startAgain() {
    const adopting = this.adopting
    this.adopting = []
    await Promise.all(
      adopting.map(async ({ preview, saved, ready, settle }) => {
        let why = await ready
        if (!why && (saved.secrets.length || (preview.remote && !preview.remote.asleep))) {
          const variables =
            saved.secrets.length && preview.info.repository
              ? await this.variables(preview.seat, preview.info.repository).catch((error: unknown) => {
                  console.warn(`preview of ${preview.seat.sessionId}: ${String(error)}`)
                  return null
                })
              : { env: saved.settings, secrets: [] }
          why = await this.goOn(preview, saved, variables).catch(
            (error: unknown) =>
              `it could not be taken up (${error instanceof Error ? error.message : String(error)})`,
          )
        }
        if (why) await this.instead(preview, saved, why)
        settle()
      }),
    )
    let again: string[] = []
    try {
      again = JSON.parse(readFileSync(this.againFile, 'utf8')) as string[]
      rmSync(this.againFile, { force: true })
    } catch {
      return
    }
    for (const sessionId of again) {
      const last = this.lastStarts.get(sessionId)
      if (!last || this.previews.has(sessionId)) continue
      await this.startInBackground(last.seat, last.input).catch((error: unknown) =>
        console.warn(`could not start the preview of ${sessionId} again: ${String(error)}`),
      )
    }
  }

  /**
   * A preview handed over that could not be taken up: started again as it last started, with
   * the credentials it was given, and says why; one nobody was using (frozen, asleep) stops.
   */
  private async instead(preview: Preview, saved: Handed, why: string) {
    const { sessionId } = preview.seat
    if (this.previews.get(sessionId) !== preview || preview.stopping) return
    console.log(`preview of ${sessionId}: ${why}; starting it again`)
    // Not taken up: stopping it waits for nothing of it (what is left goes with its cgroup, or
    // with the replacement's cleanup on its machine).
    if (!preview.run) preview.exited = Promise.resolve(null)
    if (saved.frozen || saved.remote?.asleep) {
      await this.stop(sessionId, `Stopped while Brigade updated on this computer: ${why}`)
      return
    }
    try {
      const fresh = await this.startInBackground(preview.seat, preview.input)
      this.append(fresh, `[preview] Started again after Brigade updated: ${why}\n`)
    } catch (error) {
      await this.stop(
        sessionId,
        `It could not start again after Brigade updated (${why}): ${error instanceof Error ? error.message : String(error)}`,
        'failed',
      )
    }
  }

  private get againFile() {
    return join(dirname(this.options.stateFile), 'previews-again.json')
  }

  private get handOverFile() {
    return join(dirname(this.options.stateFile), 'previews-handed.json')
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
    await this.untilReady(preview, waitFor(preview.input, Boolean(preview.remote)), signal)

    const result: PreviewResult = { status: preview.info.status, origins }
    const open = preview.info.status === 'running' ? await this.openUrl(preview) : undefined
    if (open) result.open = open
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
      await this.untilReady(preview, waitFor(preview.input, Boolean(preview.remote)))
      if (this.previews.get(seat.sessionId) !== preview || preview.info.status !== 'running') return
      await this.check(seat, []).catch((error: unknown) => {
        this.append(preview, `[preview] Its pages could not be checked: ${String(error)}\n`)
      })
    })().catch((error: unknown) => console.warn(`preview start failed: ${String(error)}`))
    return preview
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
    // One preview per thread: a new one replaces it, which frees its ports. Its machine, when it
    // has one, stays up for the new one.
    const replaced = this.previews.get(seat.sessionId)
    if (replaced?.remote) replaced.remote.keepAwake = true
    await this.stop(seat.sessionId, PREVIEW_REPLACED)
    // In the thread's own network (thread-net.ts), its ports are its own: another thread's
    // preview of the same app does not take them.
    const net = seat.runAs ? await threadNet(seat.sessionId) : null
    const others = (input.ports ?? []).filter((p) => p !== input.port)
    const notes: string[] = []
    // On a machine of its own when its thread's starter chose it (preview_machines): its ports
    // are the machine's, which nothing here holds, and the proxy reaches them forwarded here.
    const remote = await this.machineFor(seat, input, dir, net, notes)
    const host = remote ? '127.0.0.1' : net?.address
    // Taken (another thread's preview of the same app): a command reading $PORT gets a free one.
    if (!remote && PORT_VARIABLE.test(command) && (await answers(input.port, host))) {
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
      if (remote || !(await answers(port, host))) continue
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
    const proxyOptions = this.proxyOptions(() => preview, { host, port: input.port, ports })
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
        : `http://${localName(seat.sessionId)}:${publicPort}`
    } catch (error) {
      proxy.close()
      throw error
    }
    origin = origin.replace(/\/+$/, '')
    behind(proxyOptions, origin)
    const origins: Record<number, string> = Object.fromEntries([
      [input.port, origin],
      ...ports.map((p) => [p, `${origin}${PORTS_PREFIX}${p}`]),
    ])

    const { env, remoteEnv } = await appEnv(seat, input, ports, origins, variables.env)
    if (remote) remote.env = remoteEnv
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
    // Its own cgroup where the runner has them; without one it runs as before. None for one on
    // its machine: nothing of it runs here but its connection.
    const cgroup = await (remote ? null : await this.cgroups)
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
        ...(remote ? { machine: remote.link.size } : {}),
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
      hidden: hiddenValues(variables),
      settings: Object.fromEntries(
        Object.entries(variables.env).filter(([name]) => !variables.secrets.includes(name)),
      ),
      secretNames: variables.secrets,
      restarts: [],
      lines: [],
      written: 0,
      partial: '',
      lastUsed: Date.now(),
      exited: Promise.resolve(null),
      notes,
      ...(remote ? { remote } : {}),
    }
    if (remote) remote.log = (line) => this.append(preview!, `${line}\n`)
    this.previews.set(seat.sessionId, preview)
    this.remember(seat, input, repository)
    this.report(preview)
    this.launch(preview, true)
    return { preview, origins }
  }

  /** What a preview's proxy does, for the preview `current()` gives once there is one. */
  private proxyOptions(
    current: () => Preview | undefined,
    { host, port, ports }: { host: string | undefined; port: number; ports: number[] },
  ): PreviewProxyOptions {
    return {
      ...(host ? { host } : {}),
      // On a member's machine, people open it there only: nobody else on its network reaches it.
      ...(CLOUD ? {} : { bind: '127.0.0.1' }),
      port,
      ports,
      crossSiteCookies: false,
      state: (): ProxyState => {
        const preview = current()
        if (!preview || preview.info.status === 'running') return 'running'
        if (preview.restarting) return 'restarting'
        return preview.info.status === 'starting' ? 'starting' : 'down'
      },
      onUse: () => {
        const preview = current()
        if (preview) preview.lastUsed = Date.now()
      },
      // A request to a frozen preview thaws it first. One asleep on its machine is woken, which
      // takes a while: the request goes on, and its page says the app starts meanwhile.
      wake: () => {
        const preview = current()
        if (preview?.remote?.asleep) return void this.wake(preview)
        return preview?.frozen ? this.thaw(preview) : undefined
      },
      // On its machine: each of the app's ports is forwarded here (none until it is connected).
      forward: (port: number) => {
        const preview = current()
        return preview?.remote ? preview.remote.link.local(port) : port
      },
    }
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
    if (preview.remote) return void this.launchRemote(preview, withSetup)
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
    // Its output in a file of the runner's, given to the app as is (not a pipe, which would end
    // with the runner): emptied for each run, kept open for appending, so emptying it later when
    // it grows too big is safe.
    const files = this.runFiles(preview)
    mkdirSync(files.dir, { recursive: true, mode: 0o700 })
    rmSync(files.exit, { force: true })
    const out = openSync(files.output, 'a', 0o600)
    ftruncateSync(out, 0)
    // WRAPPER leads the process group sudo keeps for the app, detached: the one to stop. Its pid
    // is the computer's whatever namespaces the app runs in (thread-net.ts).
    let child: ChildProcess
    try {
      child = spawn('sh', ['-c', WRAPPER, files.exit, cgroup ? '1' : '0', as.file, ...argv], {
        cwd: '/',
        env: preview.env,
        stdio: ['ignore', out, out, ...(cgroup ? (['pipe'] as const) : [])],
        detached: true,
      })
    } finally {
      closeSync(out)
    }
    const run = this.newRun(child.pid)
    preview.run = run
    preview.group = child.pid
    processGroups.add(child.pid, `the preview of ${preview.seat.sessionId}`)
    const closed = new Promise<number | null>((done) => {
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
    this.followLocal(preview, run, closed)
  }

  /** The files of a preview's runs on this computer: its output, and how it ended. */
  private runFiles(preview: Preview) {
    const dir = join(
      dirname(this.options.stateFile),
      'preview-runs',
      `${preview.seat.sessionId}-${preview.info.previewId.slice(0, 8)}`.replace(/[^A-Za-z0-9_-]/g, '_'),
    )
    return { dir, output: join(dir, 'output.log'), exit: join(dir, 'exit') }
  }

  private newRun(pid: number | undefined, offset = 0): AppRun {
    return {
      ...(pid ? { pid } : {}),
      at: Date.now(),
      offset,
      lineOffset: offset,
      decoder: new StringDecoder('utf8'),
      following: true,
      stopFollowing: () => undefined,
    }
  }

  /**
   * Read the app's output as it comes, until it ended: told by its process (`closed`) when this
   * runner started it, else by its leader gone (a runner before this one started it), then how it
   * ended from the file its wrapper wrote. What it wrote last is read first.
   */
  private followLocal(preview: Preview, run: AppRun, closed?: Promise<number | null>) {
    const files = this.runFiles(preview)
    preview.exited = new Promise<number | null>((done) => {
      let over = false
      const finish = (code: number | null | undefined) => {
        if (over) return
        over = true
        clearInterval(timer)
        if (run.following) this.readRun(preview, run, files.output)
        done(code ?? exitStatus(files.exit))
      }
      const timer = setInterval(() => {
        this.readRun(preview, run, files.output)
        if (!closed && (existsSync(files.exit) || !alive(run.pid))) finish(null)
      }, OUTPUT_POLL_MS)
      timer.unref()
      run.stopFollowing = () => {
        run.following = false
        finish(null)
      }
      void closed?.then(finish)
    })
    void preview.exited.then((code) => this.afterExit(preview, run, code))
  }

  /** What the app wrote since it was last read, into its log; the file emptied once it grows too big. */
  private readRun(preview: Preview, run: AppRun, file: string) {
    if (!run.following) return
    let fd: number
    try {
      fd = openSync(file, 'r+')
    } catch {
      return
    }
    try {
      const size = fstatSync(fd).size
      // Emptied (by a runner before this one): read from its start.
      if (size < run.offset) run.offset = run.lineOffset = 0
      const buffer = Buffer.alloc(64 * 1024)
      while (run.offset < size) {
        const read = readSync(fd, buffer, 0, Math.min(buffer.length, size - run.offset), run.offset)
        if (read <= 0) break
        this.took(preview, run, buffer.subarray(0, read))
      }
      // Read to a line's end: nothing is lost by emptying it, and the app appends from its start.
      if (run.offset > OUTPUT_MAX && run.lineOffset === run.offset) {
        ftruncateSync(fd, 0)
        run.offset = run.lineOffset = 0
      }
    } catch (error) {
      console.warn(`could not read the output of ${preview.seat.sessionId}'s preview: ${String(error)}`)
    } finally {
      closeSync(fd)
    }
  }

  /** Bytes of the app's output, read: into its log, unless its secrets are not known. */
  private took(preview: Preview, run: AppRun, chunk: Buffer) {
    const newline = chunk.lastIndexOf(10)
    if (newline >= 0) run.lineOffset = run.offset + newline + 1
    run.offset += chunk.length
    if (!preview.blind) this.append(preview, run.decoder.write(chunk))
  }

  /** The app's run ended (not handed over): reported, or started again when it had run. */
  private async afterExit(preview: Preview, run: AppRun, code: number | null) {
    if (this.handedOver || !run.following) return
    const { cgroup } = preview
    // Killed for memory: say so rather than the bare exit code.
    const budget = (await this.cgroups)?.budget
    const oom = cgroup && budget && oomReason(preview.ooms, await cgroup.ooms(), budget)
    if (this.previews.get(preview.seat.sessionId) !== preview || preview.run !== run) return
    if (preview.stopping)
      return this.ended(preview, preview.stopping.status, preview.stopping.reason)
    const how = oom || (code === null ? 'could not start' : `exited with code ${code}`)
    const ran = preview.info.status === 'running' || preview.restarting
    // Not after the kernel killed it for memory: started again at once, it would need it again.
    if (ran && !oom && this.restartAfterExit(preview, how)) return
    // It never ran, for want of a port (the app's, or one its containers publish): say who has it.
    const taken = ran || preview.net ? '' : await this.takenSaid(preview)
    if (this.previews.get(preview.seat.sessionId) !== preview || preview.run !== run) return
    this.ended(
      preview,
      'failed',
      ran ? `The app stopped: it ${how}` : `The command ${how}${taken}`,
    )
  }

  /**
   * The thread's machine, when its starter chose previews on a machine of their own and the API
   * gives one; null to run the preview here as before, with why in `notes` when worth saying.
   */
  private async machineFor(
    seat: Seat,
    input: PreviewStart,
    dir: string,
    net: ThreadNet | null,
    notes: string[],
  ): Promise<Remote | null> {
    const machines = this.options.machines
    if (!machines) return null
    let key: { file: string; publicKey: string }
    let answer: PreviewMachineUp
    try {
      key = await machineKey(machines.home)
      answer = await machines.up(seat.sessionId, key.publicKey)
    } catch (error) {
      notes.push(
        `Its own machine could not start (${error instanceof Error ? error.message : String(error)}): it runs on this computer.`,
      )
      return null
    }
    if (!answer.machine) {
      if (answer.reason) notes.push(`${answer.reason}.`)
      return null
    }
    // The whole checkout goes, for a command in a folder of it that reads the rest (a monorepo).
    const root = await syncRoot(seat, dir)
    // The app's env file, which git may ignore, goes too.
    const includes = input.envFile ? [relative(root, resolve(dir, input.envFile))] : []
    const link = this.linkFor(answer.machine, key.file)
    const remote = this.remoteFor(seat, net, link, dir, root, includes)
    notes.push(
      `It runs on a machine of its own (${answer.machine.size}): what you change in the checkout reaches it as you change it.`,
    )
    return remote
  }

  /** A link to a thread's machine, with the runner's key. */
  private linkFor(access: PreviewMachineAccess, key: string) {
    return new MachineLink(
      access,
      key,
      join(this.options.machines!.home, 'preview-machines', access.id),
    )
  }

  /** How a preview reaches its machine, and its copy of the code there (the checkout `root`). */
  private remoteFor(
    seat: Seat,
    net: ThreadNet | null,
    link: MachineLink,
    dir: string,
    root: string,
    includes: string[],
  ): Remote {
    const machinePath = (path: string) =>
      posix.join(REMOTE_WORK, ...relative(seat.workDir, path).split(sep).filter(Boolean))
    const remote: Remote = {
      link,
      sync: undefined as unknown as MachineSync,
      dir: machinePath(dir),
      env: {},
      touchedAt: Date.now(),
      log: (line) => console.log(`preview of ${seat.sessionId}: ${line}`),
      root,
      includes,
    }
    remote.sync = new MachineSync(
      link,
      () => this.startReader(seat, net, root, includes),
      machinePath(root),
      (line) => remote.log(line),
    )
    return remote
  }

  /** The sync's reader, as the teammate in its thread's namespaces: it reads what the app would. */
  private startReader(seat: Seat, net: ThreadNet | null, root: string, includes: string[]) {
    const args = [READER, root, ...includes.flatMap((path) => ['--include', path])]
    const stdio: ['pipe', 'pipe', 'pipe'] = ['pipe', 'pipe', 'pipe']
    if (!seat.runAs) return spawn(process.execPath, args, { cwd: '/', stdio })
    const as = asTeammate(seat.runAs, net)
    return spawn(as.file, [...as.args, 'node', ...args], { cwd: '/', stdio })
  }

  /**
   * Run the app on its machine: connected, its copy of the code up to date, its ports forwarded
   * here, what an earlier run left stopped, then its setup (unless it restarts) and command there.
   */
  private launchRemote(preview: Preview, withSetup: boolean) {
    const launching = this.onMachine(preview.seat.sessionId, () =>
      this.launchRemoteNow(preview, withSetup),
    )
    preview.remote!.launching = launching
    return launching
  }

  /** Work on a thread's machine, once what is under way there is over: one thing at a time. */
  private onMachine(sessionId: string, work: () => Promise<void>) {
    const before = this.machineWork.get(sessionId)
    const next = (async () => {
      await before
      await work()
    })().catch((error: unknown) =>
      console.warn(`preview of ${sessionId}: on its machine: ${String(error)}`),
    )
    this.machineWork.set(sessionId, next)
    void next.finally(() => {
      if (this.machineWork.get(sessionId) === next) this.machineWork.delete(sessionId)
    })
    return next
  }

  /**
   * After the thread's launch before it: it gives up, before it changes anything on the machine,
   * as soon as the preview is stopped or replaced (each step on the machine takes a while).
   */
  private async launchRemoteNow(preview: Preview, withSetup: boolean) {
    const remote = preview.remote!
    const { sessionId, runAs } = preview.seat
    const current = () =>
      this.previews.get(sessionId) === preview &&
      !preview.stopping &&
      !remote.asleep &&
      !this.handedOver
    try {
      if (!current()) return
      await remote.link.connect()
      if (!current()) return
      const sent = await remote.sync.flush()
      if (sent !== undefined)
        remote.log(
          sent
            ? `[preview] Sent the code to its machine (${sent} file${sent === 1 ? '' : 's'}); changes go as they happen`
            : '[preview] Its machine has the code; changes go as they happen',
        )
      for (const port of [preview.input.port, ...preview.info.ports]) {
        if (!current()) return
        await remote.link.forward(port)
      }
      const credentials = await Promise.all(
        preview.envFiles.map((file) => runAsUser(['cat', '--', file], runAs)),
      )
      if (!current()) return
      // What an earlier run left (a runner that stopped short) would hold its ports. Only this
      // launch is under way on the machine: the one before it ended first.
      await signalApp(remote.link, 'KILL')
      if (!current()) return
      const setup = withSetup ? preview.input.setup?.trim() : undefined
      await writeRun(
        remote.link,
        remote.env,
        credentials,
        remoteScript({
          dir: remote.dir,
          envFiles: credentials.length,
          ...(setup ? { setup } : {}),
          command: preview.info.command,
          appStarts: APP_STARTS,
        }),
      )
    } catch (error) {
      if (current())
        this.ended(
          preview,
          'failed',
          `Its machine could not run it: ${error instanceof Error ? error.message : String(error)}`,
        )
      return
    }
    if (!current()) return
    try {
      await startApp(remote.link)
    } catch (error) {
      // The runner is handing over: the next one finds whether it started there.
      if (current())
        this.ended(
          preview,
          'failed',
          `The command could not start on its machine: ${error instanceof Error ? error.message : String(error)}`,
        )
      return
    }
    this.followRemote(preview, remote, this.newRun(undefined))
  }

  /**
   * Read the app's output on its machine as it comes, until it ended there: a connection cut
   * meanwhile is made again, and read on from where it was.
   */
  private followRemote(preview: Preview, remote: Remote, run: AppRun) {
    preview.run = run
    preview.exited = new Promise<number | null>((done) => {
      run.stopFollowing = () => {
        run.following = false
        run.follower?.kill('SIGKILL')
        done(null)
      }
      void this.untilRemoteEnds(preview, remote, run).then(done)
    })
    void preview.exited.then((code) => this.afterRemoteExit(preview, remote, run, code))
  }

  private async untilRemoteEnds(preview: Preview, remote: Remote, run: AppRun) {
    const { link } = remote
    for (let cuts = 0; ; ) {
      if (!run.following) return null
      const code = await this.readRemote(preview, run, link, true)
      if (!run.following) return null
      const state = await appState(link)
      if (!run.following) return null
      if (state?.state === 'ended') {
        // What it wrote after the follow was cut (the connection lost as it ended), to its end.
        for (let tries = 0; tries < 3 && run.following; tries++)
          if ((await this.readRemote(preview, run, link, false)) === 0) break
        return state.code
      }
      if (state?.state === 'gone') return null
      if (state?.state === 'running' && code !== 255) {
        // Its script is gone but not what it started (being stopped), or its follow failed: again,
        // a second later.
        await sleep(1000)
        continue
      }
      // The connection was cut (ssh says 255): made again, then followed on from where it was.
      if (++cuts > 5 || !(await link.connect().then(() => true, () => false))) {
        run.lost = true
        return null
      }
    }
  }

  /** Its output file there from the byte read so far, into its log. Resolves to ssh's exit code. */
  private readRemote(preview: Preview, run: AppRun, link: MachineLink, follow: boolean) {
    return new Promise<number | null>((done) => {
      const child = readOutput(link, run.offset, follow)
      run.follower = child
      child.stdout!.on('data', (data: Buffer) => {
        if (run.following) this.took(preview, run, data)
      })
      child.stderr!.resume()
      child.once('error', () => done(null))
      child.once('close', (exit) => {
        if (run.follower === child) run.follower = undefined
        done(exit)
      })
    })
  }

  /** The app ended on its machine (not handed over, nor asleep): reported, or started again. */
  private afterRemoteExit(preview: Preview, remote: Remote, run: AppRun, code: number | null) {
    const { sessionId } = preview.seat
    if (this.handedOver || this.previews.get(sessionId) !== preview || preview.run !== run) return
    // Asleep: stopped on purpose, with its machine.
    if (remote.asleep) return
    if (preview.stopping) return this.ended(preview, preview.stopping.status, preview.stopping.reason)
    const how = run.lost
      ? 'lost its connection to its machine'
      : code === null
        ? 'was stopped on its machine'
        : `exited with code ${code}`
    const ran = preview.info.status === 'running' || preview.restarting
    if (ran && this.restartAfterExit(preview, how)) return
    this.ended(preview, 'failed', ran ? `The app stopped: it ${how}` : `The command ${how}`)
  }

  /** While it is up: asleep once unused for SLEEP_MS, stopped as any preview, else said in use. */
  private async tendRemote(preview: Preview, remote: Remote, now: number) {
    const { sessionId } = preview.seat
    if (now - preview.lastUsed >= FROZEN_TTL_MS)
      return this.stop(
        sessionId,
        `Stopped after ${Math.round(FROZEN_TTL_MS / 3_600_000)} hours without use`,
      )
    if (remote.asleep || remote.waking || preview.stopping) return
    if (now - preview.lastUsed >= SLEEP_MS) return this.sleepRemote(preview, remote)
    if (now - remote.touchedAt < TOUCH_MS) return
    remote.touchedAt = now
    await this.options.machines?.touch(sessionId).catch((error: unknown) => {
      console.warn(`preview of ${sessionId}: could not say its machine is in use: ${String(error)}`)
    })
  }

  /** Unused for SLEEP_MS: the app stops, and its machine with it; the next request wakes them. */
  private async sleepRemote(preview: Preview, remote: Remote) {
    if (remote.asleep || preview.stopping || preview.info.status !== 'running') return
    remote.asleep = true
    this.append(
      preview,
      `[preview] Asleep after ${Math.round(SLEEP_MS / 60_000)} minutes without use: its machine stopped, ` +
        'and the next visit wakes it in about half a minute\n',
    )
    remote.sleeping = this.onMachine(preview.seat.sessionId, async () => {
      remote.sync.stop()
      await signalApp(remote.link, 'TERM')
      preview.run?.stopFollowing()
      // Its settings and credentials are on the machine while the app runs only: written again
      // when it wakes.
      await clearRun(remote.link)
      remote.link.close()
      await this.options.machines?.sleep(preview.seat.sessionId).catch((error: unknown) => {
        console.warn(
          `preview of ${preview.seat.sessionId}: its machine did not stop: ${String(error)}`,
        )
      })
    })
    await remote.sleeping
  }

  /**
   * A request came while it was asleep, or a check: its machine starts again, then the app,
   * without its setup (what it made is on the machine's disk). Resolves once it answers.
   */
  private wake(preview: Preview) {
    const remote = preview.remote!
    remote.waking ??= (async () => {
      const { sessionId } = preview.seat
      preview.info = { ...preview.info, status: 'starting', reason: 'Waking its machine' }
      this.report(preview)
      this.append(preview, '[preview] Waking its machine\n')
      // Still going to sleep: started again only once it stopped. Taken up after an update: once
      // its environment is made again.
      await remote.sleeping
      await preview.ready
      if (preview.blind) {
        await this.stop(
          sessionId,
          'Its secret variables could not be read again after Brigade updated: start the preview again',
          'failed',
        )
        return
      }
      try {
        const machines = this.options.machines
        if (!machines) throw new Error('this runner has none')
        const key = await machineKey(machines.home)
        const answer = await machines.up(sessionId, key.publicKey)
        if (!answer.machine) throw new Error(answer.reason ?? 'it is not available any more')
        remote.link.update(answer.machine)
      } catch (error) {
        await this.stop(
          sessionId,
          `Its machine did not wake (${error instanceof Error ? error.message : String(error)}): start the preview again`,
          'failed',
        )
        return
      }
      remote.asleep = false
      preview.lastUsed = remote.touchedAt = Date.now()
      // With its setup: what it started (a database, a service) stopped with the machine, and a
      // machine made again (the provider lost the old one) has none of it yet.
      this.launch(preview, true)
      await this.untilReady(preview, SETUP_START_MS)
    })().finally(() => {
      remote.waking = undefined
    })
    return remote.waking
  }

  /** It ended: its connection closes, and its machine stops unless another start takes it on. */
  private endRemote(preview: Preview, remote: Remote) {
    remote.sync.stop()
    // After its launch gave up, before a replacement's starts: its app and its settings and
    // credentials leave the machine (asleep, they already did).
    return this.onMachine(preview.seat.sessionId, async () => {
      if (!remote.asleep) {
        await signalApp(remote.link, 'KILL')
        await clearRun(remote.link)
      }
      remote.link.close()
      if (remote.asleep || remote.keepAwake) return
      await this.options.machines?.sleep(preview.seat.sessionId).catch((error: unknown) => {
        console.warn(
          `preview of ${preview.seat.sessionId}: its machine did not stop: ${String(error)}`,
        )
      })
    })
  }

  /** An app that ran stopped: start it again after a while, unless it did too often. */
  private restartAfterExit(preview: Preview, how: string) {
    const now = Date.now()
    preview.restarts = preview.restarts.filter((at) => now - at < RESTART_WINDOW_MS)
    const delay = RESTART_DELAYS_MS[preview.restarts.length]
    // Without its secrets (a runner after an update could not read them), it cannot run again.
    if (delay === undefined || preview.blind || this.handedOver) return false
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
      if (this.handedOver) return
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
      // On its machine, its port is asked there (a forward here accepts any connection), then
      // reached through the forward.
      const { remote } = preview
      const host = remote ? '127.0.0.1' : preview.net?.address
      const port = remote ? remote.link.local(preview.input.port) : preview.input.port
      const listening = remote
        ? port !== undefined && (await remote.link.answers(preview.input.port))
        : await answers(preview.input.port, host)
      if (listening && port !== undefined) {
        const status = await httpStatus(port, host)
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
    if (!cgroup && !stoppable(preview)) return
    if (preview.frozen || preview.info.status !== 'running' || preview.stopping) return
    preview.frozen = true
    const after = `Paused after ${Math.round(FREEZE_MS / 60_000)} minutes without use`
    return this.pause(preview, async () => {
      if (cgroup) {
        await cgroup.freeze()
        const freed = await cgroup.reclaim()
        this.append(
          preview,
          `[preview] ${after} (${Math.round(freed / 1024 ** 2)} MB given back); the next request resumes it\n`,
        )
      } else {
        signalGroup(preview, 'SIGSTOP')
        this.append(preview, `[preview] ${after}; the next request resumes it\n`)
      }
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
      if (preview.cgroup) await preview.cgroup.thaw()
      else signalGroup(preview, 'SIGCONT')
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

  /**
   * The thread's containers while nobody works in it: the teammate's on a cloud
   * computer, its Compose project's in the member's Docker on their machine.
   */
  private async pauseContainers(preview: Preview) {
    const { runAs, sessionId } = preview.seat
    if (!preview.frozen || preview.pausedContainers || this.options.busy?.(sessionId)) return
    if (!runAs && CLOUD) return
    const paused = runAs ? pauseFor(runAs, sessionId) : pauseMember(sessionId)
    const ids = await paused.catch((error: unknown) => {
      this.append(preview, `[preview] Could not pause the thread's containers: ${String(error)}\n`)
      return []
    })
    if (ids.length === 0) return
    preview.pausedContainers = ids
    this.savePaused()
    this.append(preview, `[preview] Paused ${ids.length} of the thread's containers\n`)
  }

  private async unpauseContainers(preview: Preview) {
    const ids = preview.pausedContainers
    delete preview.pausedContainers
    if (!ids?.length) return
    const entry: Paused = [preview.seat.runAs ?? '', preview.seat.sessionId, ids]
    // Noted while Docker answers, so another save meanwhile keeps it should the runner stop.
    this.unresumed.push(entry)
    this.trying.add(entry)
    const left = await resume(entry).finally(() => this.trying.delete(entry))
    this.unresumed = this.unresumed.filter((e) => e !== entry)
    if (left.length) {
      this.unresumed.push([entry[0], entry[1], left])
      this.append(
        preview,
        `[preview] Could not resume ${left.length} of the thread's containers: trying again each minute\n`,
      )
    }
    this.savePaused()
  }

  /** Try again to resume the containers left paused. */
  private resumeLeft() {
    if (this.resuming || this.unresumed.length === 0) return this.resuming
    this.resuming = (async () => {
      // Each stays noted until tried, should the runner stop meanwhile; one a wake is resuming
      // is its own.
      for (const entry of this.unresumed.filter((e) => !this.trying.has(e))) {
        const left = await resume(entry)
        this.unresumed = this.unresumed.filter((e) => e !== entry)
        if (left.length) this.unresumed.push([entry[0], entry[1], left])
      }
      this.savePaused()
    })().finally(() => (this.resuming = undefined))
    return this.resuming
  }

  private savePaused() {
    const paused: Paused[] = [...this.unresumed]
    for (const p of this.previews.values())
      if (p.pausedContainers?.length)
        paused.push([p.seat.runAs ?? '', p.seat.sessionId, p.pausedContainers])
    try {
      writeFileSync(this.pausedFile, JSON.stringify(paused), { mode: 0o600 })
    } catch (error) {
      console.warn(`could not save the paused containers: ${String(error)}`)
    }
  }

  /**
   * Stop a preview stalled on memory for a while (PressureWatch), at once and
   * with the reason: it would only grow slower and slow everything else.
   */
  private async watchPressure() {
    if (this.handedOver) return
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
    const { remote } = preview
    if (remote) {
      // Its process group on its machine (asleep, the machine stopped with it), then the
      // connection that carried its output.
      if (!remote.asleep) void signalApp(remote.link, signal)
      if (signal === 'KILL') preview.run?.stopFollowing()
      return
    }
    // Whatever left its process group too (a daemon, a setsid'd child) is still in its cgroup.
    if (signal === 'KILL') void preview.cgroup?.kill()
    const group = preview.group
    if (!group) return
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
    if (preview.remote) void this.endRemote(preview, preview.remote)
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
    if (this.handedOver) return
    const now = Date.now()
    for (const [sessionId, preview] of this.previews) {
      // A turn or a person working in the thread uses its preview, through the proxy or not.
      if (this.options.busy?.(sessionId)) preview.lastUsed = now
      if (preview.remote) {
        void this.tendRemote(preview, preview.remote, now)
        continue
      }
      const ttl = preview.cgroup ? FROZEN_TTL_MS : TTL_MS
      if (now - preview.lastUsed >= ttl)
        void this.stop(sessionId, `Stopped after ${Math.round(ttl / 60_000)} minutes without use`)
      else if (now - preview.lastUsed >= FREEZE_MS) void this.freeze(preview)
    }
    void this.resumeLeft()
    void this.makeRoom()
  }

  /** The computer runs short of memory or swap: stop the frozen preview unused longest. */
  private async makeRoom() {
    const frozen = [...this.previews.values()].filter((p) => p.frozen)
    if (!frozen.length) return
    const meminfo = await readFile('/proc/meminfo', 'utf8').catch(() => '')
    // Not Linux (a member's Mac): nothing to read, and frozen previews stop after TTL_MS anyway.
    if (!meminfo) return
    const kB = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(meminfo)?.[1])
    const swapUsed = kB('SwapTotal') > 0 ? 1 - kB('SwapFree') / kB('SwapTotal') : 0
    if (swapUsed < SWAP_FULL && kB('MemAvailable') / kB('MemTotal') > MEMORY_SHORT) return
    const oldest = frozen.reduce((a, b) => (b.lastUsed < a.lastUsed ? b : a))
    await this.stop(oldest.seat.sessionId, 'Stopped to make room for other previews')
  }
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

/** A proxy behind the address people open: cookies for the dashboard's frame over HTTPS, and its host. */
function behind(options: PreviewProxyOptions, origin: string) {
  // In the dashboard's frame (another site), only these cookies are kept; they need HTTPS.
  options.crossSiteCookies = origin.startsWith('https:')
  // Behind the preview gateway, the app is asked for the gateway's host, not the provider's.
  if (options.crossSiteCookies) options.publicHost = new URL(origin).host
}

/**
 * The app's environment: this computer's for the teammate, its addresses, its settings and
 * people's variables over them. On its machine, its own settings only: this computer's
 * environment (its paths, the teammate's home) means nothing there.
 */
async function appEnv(
  seat: Seat,
  input: Pick<PreviewStart, 'port' | 'env'>,
  ports: number[],
  origins: Record<number, string>,
  variables: Record<string, string>,
) {
  const origin = origins[input.port]!
  const own = {
    PORT: String(input.port),
    // On a cloud computer, reachable from the proxy whatever address it binds. On a member's
    // machine, the proxy is on the loopback too, and nobody else on its network needs the app.
    HOST: CLOUD ? '0.0.0.0' : '127.0.0.1',
    BRIGADE_PREVIEW_URL: origin,
    ...Object.fromEntries([input.port, ...ports].map((p) => [`BRIGADE_PREVIEW_URL_${p}`, origins[p]!])),
    // People's variables over the start's own settings.
    ...withAddresses({ ...input.env, ...variables }, origin, origins),
  }
  const env = harnessEnv({
    ...(seat.runAs
      ? {
          ...(await containerEnv(seat.runAs, seat.sessionId)),
          HOME: teammateHome(seat.runAs),
          USER: seat.runAs,
          LOGNAME: seat.runAs,
        }
      : { COMPOSE_PROJECT_NAME: composeProject(seat.sessionId) }),
    ...own,
  })
  const remoteEnv: Record<string, string> = {
    ...own,
    HOST: '0.0.0.0',
    ...withAddresses({ ...input.env, ...variables }, origin, origins),
  }
  return { env, remoteEnv }
}

/** The values of a repository's secret variables, hidden in its preview's log. */
const hiddenValues = (variables: { env: Record<string, string>; secrets: string[] }) =>
  variables.secrets
    .map((name) => variables.env[name] ?? '')
    .filter((value) => value.length >= HIDDEN_MIN)

/** How a run of the app ended, as its wrapper noted; null when it did not (it was killed). */
function exitStatus(file: string) {
  try {
    const code = Number.parseInt(readFileSync(file, 'utf8'), 10)
    return Number.isNaN(code) ? null : code
  } catch {
    return null
  }
}

/** Whether a process runs (a teammate's too: it is there, only not ours to signal). */
function alive(pid: number | undefined) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** ps gives start times to the second, and a run is noted just after its leader started. */
const STARTED_SLACK_MS = 5_000

/** Whether the process that led a run (started at `at`) still runs: not another one given its pid since. */
async function leads(pid: number | undefined, at: number) {
  if (!alive(pid)) return false
  const proc = (await processes().catch(() => [])).find((p) => p.pid === pid)
  return !!proc && Math.abs(proc.started - at) <= STARTED_SLACK_MS
}

/** When the computer last started, in ms since the epoch (to the minute or so). */
const bootTime = () => Date.now() - uptime() * 1000

/**
 * The name a thread's preview is opened at on a member's machine: its own
 * under .localhost, which browsers and macOS take to the loopback, so its
 * cookies are its own.
 */
export const localName = (sessionId: string) =>
  `${
    sessionId
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '')
      .slice(0, 63) || 'preview'
  }.localhost`

/**
 * The previews a runner before this one handed over, when it was just now on this boot of the
 * computer: none otherwise, their processes being gone and their pids someone else's.
 */
function readHandOver(file: string): Handed[] {
  try {
    const note = JSON.parse(readFileSync(file, 'utf8')) as HandOver
    const fresh = Date.now() - note.at < HANDED_FRESH_MS && Math.abs(note.boot - bootTime()) <= 60_000
    return fresh && Array.isArray(note.previews) ? note.previews : []
  } catch {
    return []
  }
}

/** Containers paused for a preview: [user, thread, ids], the user '' for the member's own Docker. */
type Paused = [string, string, string[]]

/** The containers pausedFile notes; [user, ids] from before threads had their own Docker. */
function readPaused(file: string): Paused[] {
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as (Paused | [string, string[]])[]
    return saved.map((entry) => (entry.length === 3 ? entry : [entry[0], '', entry[1]]))
  } catch {
    return []
  }
}

/** Resume paused containers: resolves to those still paused, to try again later. */
async function resume([user, sessionId, ids]: Paused): Promise<string[]> {
  if (!user) return unpauseMember(ids)
  return unpause(user, sessionId, ids).then(
    () => [],
    (error: unknown) => {
      console.warn(`could not resume the containers of ${user}: ${String(error)}`)
      return ids
    },
  )
}

/** Its processes can be stopped and resumed with signals: the runner's own, on a member's machine. */
const stoppable = (preview: Preview) => !CLOUD && !preview.seat.runAs && Boolean(preview.group)

/** Stop or resume the preview's process group, where stoppable. */
function signalGroup(preview: Preview, signal: 'SIGSTOP' | 'SIGCONT') {
  if (!stoppable(preview)) return
  try {
    process.kill(-preview.group!, signal)
  } catch {
    // already gone
  }
}

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

/**
 * What goes to a preview's machine: the checkout the app's folder is in, whole (a command in a
 * folder of a monorepo reads the rest), or the folder alone outside a checkout of the teammate's.
 */
async function syncRoot(seat: Seat, dir: string) {
  const top = (
    await runAsUser(['git', '-C', dir, 'rev-parse', '--show-toplevel'], seat.runAs).catch(() => '')
  ).trim()
  return top && (top === seat.workDir || top.startsWith(`${seat.workDir}${sep}`)) ? top : dir
}

/**
 * How long to wait for the app's port: longer when a setup runs first, or on its own machine,
 * which may first need its code and everything the app installs.
 */
const waitFor = (input: PreviewStart, remote = false) =>
  Math.min(
    input.timeoutMs ?? (input.setup || remote ? SETUP_START_MS : PREVIEW_START_MS),
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
