// The Brigade runner, as the API's install script sets it up in ~/.brigade: Node.js, the runner
// bundle and its wrapper, bin/brigade-runner, which starts the new runner when it updates
// itself (exit code 75). Brigade.app installs it with that same script, links it with a code
// from the dashboard, and keeps `brigade-runner start` running. The runner keeps updating
// itself as before. macOS and Linux: the runner and its install script are POSIX only.
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { home, logFile } from './settings.js'
import * as workspaces from './workspaces.js'

const run = promisify(execFile)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export type Status =
  /** No runner installed yet, or installed but not linked to a workspace. */
  | { kind: 'notConnected' }
  | { kind: 'installing' }
  | { kind: 'running'; workspace: string }
  /** A runner started elsewhere (a terminal) is running: two would fight over the same computer. */
  | { kind: 'elsewhere' }
  /** The runner stopped and will start again shortly. */
  | { kind: 'restarting'; reason: string }
  | { kind: 'stopped' }
  /** Windows: no runner there yet. */
  | { kind: 'unsupported' }

export function label(status: Status) {
  switch (status.kind) {
    case 'notConnected':
      return 'Not connected to a workspace'
    case 'installing':
      return 'Setting up…'
    // Its workspace shows in the Workspace submenu just below.
    case 'running':
      return '● Running'
    case 'elsewhere':
      return 'Runner already running in a terminal'
    case 'restarting':
      return `Restarting: ${status.reason}`
    case 'stopped':
      return 'Stopped'
    case 'unsupported':
      return 'Teammates run on macOS and Linux'
  }
}

/** Whether this computer can run teammates: the runner and its installer are POSIX only. */
export const runnerSupported = (platform = process.platform) =>
  platform === 'darwin' || platform === 'linux'

const wrapper = () => join(home(), 'bin', 'brigade-runner')

/** The home of the workspace the runner runs for: its runner.json, runner.pid, state. */
const workspaceHome = () => workspaces.homeOf(workspaces.active())

/** The workspace this computer runs for, from its runner's own config. */
export function workspace(): string | undefined {
  try {
    const config = JSON.parse(readFileSync(join(workspaceHome(), 'runner.json'), 'utf8'))
    return typeof config.workspaceName === 'string' ? config.workspaceName : undefined
  } catch {
    return undefined
  }
}

/** The log, appended to; started over once it passes 5 MB. A file descriptor for a child. */
function openLog() {
  const path = logFile()
  mkdirSync(dirname(path), { recursive: true })
  try {
    if (statSync(path).size > 5_000_000) renameSync(path, `${path}.1`)
  } catch {}
  return openSync(path, 'a')
}

/** Commands the runner starts (git, the harness CLIs) are found where a person's shell finds them. */
export function pathEnv(path = process.env.PATH) {
  const base = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
  return path ? `${base}:${path}` : base
}

/** A command whose output goes to the runner's log, in a process group of its own. */
function start(program: string, args: string[], env: NodeJS.ProcessEnv = {}): ChildProcess {
  const log = openLog()
  try {
    return spawn(program, args, {
      env: { ...process.env, PATH: pathEnv(), ...env },
      stdio: ['ignore', log, log],
      // A process group (and session) of its own, so stop() reaches node behind the wrapper.
      detached: true,
    })
  } finally {
    closeSync(log)
  }
}

/** Runs a command to its end: its exit code, or an error when it could not start. */
function complete(program: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return new Promise<number | null>((resolve, reject) => {
    let child: ChildProcess
    try {
      child = start(program, args, env)
    } catch (error) {
      return reject(error)
    }
    child.once('error', reject)
    child.once('exit', (code) => resolve(code))
  })
}

/** Exit code of a runner that found another one running from the same home. */
export const ALREADY_RUNNING = 3

async function output(program: string, args: string[]) {
  try {
    return (await run(program, args)).stdout
  } catch (error) {
    // pgrep exits 1 when nothing matches; its output is still the answer.
    return (error as { stdout?: string }).stdout ?? ''
  }
}

/** A runner this app did not start, e.g. in a terminal: the one holding runner.pid (newer
 * runners), or one `pgrep` finds by its entry point (older ones). */
async function runningElsewhere() {
  const pids = new Set<number>()
  try {
    const holder = Number(readFileSync(join(workspaceHome(), 'runner.pid'), 'utf8').trim())
    if (Number.isInteger(holder) && holder > 0) pids.add(holder)
  } catch {}
  for (const line of (await output('pgrep', ['-f', 'runner/dist/index.js start'])).split('\n')) {
    const pid = Number(line.trim())
    if (Number.isInteger(pid) && pid > 0) pids.add(pid)
  }
  for (const pid of pids) {
    const command = await output('ps', ['-o', 'command=', '-p', String(pid)])
    if (command.includes('node') || command.includes('tsx')) return true
  }
  return false
}

/** The process group of the runner this app started, kept until it exits: a runner left
 * behind when the app was killed is the app's to stop, not "elsewhere". */
const groupFile = () => join(home(), 'desktop-runner.pgid')

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const signalGroup = (group: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-group, signal)
  } catch {}
}

/** Stops a runner group an earlier run of this app left behind. */
async function stopOrphan() {
  let group: number
  try {
    group = Number(readFileSync(groupFile(), 'utf8').trim())
  } catch {
    return
  }
  if (Number.isInteger(group) && group > 1) {
    const command = await output('ps', ['-o', 'command=', '-p', String(group)])
    if (command.includes('brigade-runner')) {
      signalGroup(group, 'SIGTERM')
      const until = Date.now() + 60_000
      while (alive(group) && Date.now() < until) await sleep(200)
      signalGroup(group, 'SIGKILL')
      // Its node process removes runner.pid as it exits.
      await sleep(500)
    }
  }
  rmSync(groupFile(), { force: true })
}

type Running = { process: ChildProcess; exited: Promise<number | null> }

/** SIGTERM to the whole group (the wrapper and node): the runner freezes a turn in progress and
 * carries on with it after the next start. Killed after a minute. */
async function terminate(child: Running, graceMs: number) {
  const group = child.process.pid
  if (!group) return
  signalGroup(group, 'SIGTERM')
  const done = await Promise.race([child.exited.then(() => true), sleep(graceMs).then(() => false)])
  if (!done) {
    signalGroup(group, 'SIGKILL')
    await child.exited
  }
}

export type SupervisorOptions = {
  /** Brigade Computer Use.app, given to the runner (macOS). */
  helper?: string
  onChange: (status: Status) => void
  /** How long a stopping runner gets before it is killed. */
  graceMs?: number
  /** The first wait before a failed runner starts again. */
  backoffMs?: number
  /** Whether a runner this app did not start runs here (tests replace it). */
  runningElsewhere?: () => Promise<boolean>
}

export class Supervisor {
  status: Status = { kind: 'stopped' }
  private child: Running | undefined
  private wanted = false
  /** Increments on each start, so an old loop stops when a new one begins. */
  private generation = 0
  /** Starts, stops, links and switches, one at a time: none runs for a workspace another is
   * changing. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: SupervisorOptions) {}

  private set(status: Status) {
    this.status = status
    this.options.onChange(status)
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => {})
    return next
  }

  /** Keeps `brigade-runner start` running until stop(), restarting it when it exits. */
  start() {
    return this.serial(() => this.startNow())
  }

  stop() {
    return this.serial(() => this.stopNow())
  }

  private async startNow() {
    await this.stopNow()
    if (!runnerSupported()) return this.set({ kind: 'unsupported' })
    this.wanted = true
    const generation = ++this.generation
    void this.supervise(generation)
  }

  private current(generation: number) {
    return this.wanted && this.generation === generation
  }

  private async supervise(generation: number) {
    let backoff = this.options.backoffMs ?? 2_000
    const first = backoff
    while (this.current(generation)) {
      const name = existsSync(wrapper()) ? workspace() : undefined
      if (!name) return this.set({ kind: 'notConnected' })
      await stopOrphan()
      if (!this.current(generation)) return
      if (await (this.options.runningElsewhere ?? runningElsewhere)()) {
        if (this.current(generation)) this.set({ kind: 'elsewhere' })
        return
      }
      // Checked again just before the spawn, with nothing awaited in between: a stop or a new
      // start meanwhile ends this loop before it starts a runner of its own.
      if (!this.current(generation)) return
      let child: ChildProcess
      try {
        child = start(wrapper(), ['start'], {
          BRIGADE_HOME: workspaceHome(),
          ...(this.options.helper && { BRIGADE_COMPUTER_USE_APP: this.options.helper }),
        })
      } catch (error) {
        this.set({ kind: 'restarting', reason: (error as Error).message })
        await sleep(backoff)
        continue
      }
      let failure: string | undefined
      const exited = new Promise<number | null>((resolve) => {
        child.once('exit', (code) => resolve(code))
        // It never started (a missing or broken wrapper): no exit follows.
        child.once('error', (error) => {
          failure = error.message
          resolve(null)
        })
      })
      const running: Running = { process: child, exited }
      this.child = running
      const started = Date.now()
      if (child.pid) writeFileSync(groupFile(), String(child.pid))
      this.set({ kind: 'running', workspace: name })
      const code = await exited
      // stop() took it: it is stop()'s to end and report.
      if (this.child !== running) return
      this.child = undefined
      rmSync(groupFile(), { force: true })
      if (!this.current(generation)) return
      if (code === ALREADY_RUNNING) return this.set({ kind: 'elsewhere' })
      // A runner that ran for a while gets a quick restart; one that keeps failing waits longer.
      backoff = Date.now() - started > 60_000 ? first : Math.min(backoff * 2, 60_000)
      const reason = failure ?? (code === null ? 'stopped' : `exited with code ${code}`)
      this.set({ kind: 'restarting', reason })
      await sleep(backoff)
    }
  }

  private async stopNow() {
    this.wanted = false
    const child = this.child
    this.child = undefined
    if (child) {
      await terminate(child, this.options.graceMs ?? 60_000)
      rmSync(groupFile(), { force: true })
    }
    if (!['notConnected', 'elsewhere', 'unsupported'].includes(this.status.kind))
      this.set({ kind: 'stopped' })
  }

  /**
   * Installs the runner with the API's script (Node.js too when needed), links the home of the
   * workspace the link names (`workspaceId`, see workspaces.ts) with a dashboard code, then
   * runs it for that workspace. Resolves with what went wrong, if anything.
   */
  connect(api: string, code: string, workspaceId: string | undefined) {
    return this.serial(async (): Promise<string | undefined> => {
      const { key, created } = workspaces.homeForLink(workspaceId, api)
      await this.stopNow()
      this.set({ kind: 'installing' })
      const target = workspaces.homeOf(key)
      let error: string | undefined
      try {
        const installed = await complete(
          'sh',
          ['-c', 'curl -fsSL "$1/runner/install.sh" | sh', 'sh', api],
          { BRIGADE_INSTALL_DIR: home() },
        )
        if (installed !== 0) error = 'The runner could not be installed. See the logs.'
        else {
          mkdirSync(target, { recursive: true })
          const linked = await complete(wrapper(), ['link', code, '--api', api], {
            BRIGADE_HOME: target,
          })
          if (linked !== 0)
            error =
              'This link code did not work: it may have expired. Get a new one in the dashboard.'
        }
      } catch (failure) {
        error = (failure as Error).message
      }
      if (!error) workspaces.setActive(key)
      // A home made for this link and never linked: nothing in it to keep.
      else if (created && !existsSync(join(target, 'runner.json')))
        rmSync(target, { recursive: true, force: true })
      // Linked: run it. Failed: back to whatever this computer was before.
      await this.startNow()
      return error
    })
  }

  /** Runs the runner for another workspace linked here: the current one stops (its turns are
   * saved, and carry on when it runs again), then the other's starts. */
  switch(key: string) {
    return this.serial(async () => {
      await this.stopNow()
      workspaces.setActive(key)
      await this.startNow()
    })
  }
}
