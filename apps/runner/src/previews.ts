// Live previews: an app a teammate runs in its thread (usually a dev server),
// kept by the runner rather than the harness, so it keeps answering after the
// turn ends and the harness session parks. One per thread; starting another
// replaces it. A person opens it from the dashboard, at an address the API
// gives out; on a cloud computer the provider hosts its ports publicly.
//
// It expires a while after anyone last used it (a teammate's preview tool, a
// person viewing it), so a forgotten dev server does not keep the computer up.
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import { relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { PREVIEW_LOG_LINES, type AgentEvent, type PreviewInfo } from '@brigade/contracts'
import { harnessEnv } from './harness/env.js'
import { teammateHome } from './teammates.js'

const run = promisify(execFile)

/** A preview nobody used for this long stops. */
const TTL_MS = Number(process.env.BRIGADE_PREVIEW_TTL_MS) || 30 * 60_000
/** How long a teammate's start_preview waits for the port, unless it says. */
export const PREVIEW_START_MS = 120_000
export const PREVIEW_START_MAX_MS = 600_000
/** Longest line kept in the log. */
const LINE_MAX = 2000

export type PreviewStart = {
  command: string
  /** Relative to the teammate's working directory. */
  cwd?: string
  port: number
  /** Other ports the app's pages call (its API), hosted too. */
  ports?: number[]
  timeoutMs?: number
}

/** What a teammate's preview tools reach: its thread's preview. */
export type PreviewControl = {
  start(input: PreviewStart, signal?: AbortSignal): Promise<PreviewResult>
  stop(): Promise<{ stopped: boolean }>
  logs(lines?: number): { status: PreviewInfo['status'] | 'none'; logs: string }
}

export type PreviewResult = {
  status: PreviewInfo['status']
  /** Where the app answers for a person, by port, with no token. */
  origins: Record<number, string>
  reason?: string
  logs?: string
}

type Seat = { sessionId: string; teammateId: string; workDir: string; runAs?: string }

type Preview = {
  info: PreviewInfo
  seat: Seat
  input: PreviewStart
  child: ChildProcess
  /** The process group to stop. */
  group?: number
  lines: string[]
  partial: string
  lastUsed: number
  /** Set when a stop was asked for: how its exit is reported. */
  stopping?: { status: 'failed' | 'stopped'; reason: string }
  exited: Promise<number | null>
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\r/g

/** Whether something answers on a local port. */
function answers(port: number, timeoutMs = 1000) {
  return new Promise<boolean>((done) => {
    const socket = createConnection({ host: '127.0.0.1', port })
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

  constructor(
    private readonly options: {
      emit: (sessionId: string, event: AgentEvent) => void
      /**
       * The public origins of a thread's ports, by port: on a cloud computer
       * from the API (the provider hosts them); null where the runner has no
       * public address (a member's own machine).
       */
      expose: ((sessionId: string, ports: number[]) => Promise<Record<number, string>>) | null
    },
  ) {
    this.timer = setInterval(() => this.expire(), 60_000)
    this.timer.unref()
  }

  /** Previews running or starting. */
  get count() {
    return this.previews.size
  }

  /** A seat's preview tools: its thread's preview, as its teammate. */
  forSeat(seat: Seat): PreviewControl {
    return {
      start: (input, signal) => this.start(seat, input, signal),
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

  /** Start the preview again, as it was started. */
  async restart(sessionId: string) {
    const preview = this.previews.get(sessionId)
    if (!preview) throw new Error('This thread has no preview running')
    await this.start(preview.seat, preview.input)
  }

  /** Stop a thread's preview, reported as stopped or failed. Returns whether one was running. */
  async stop(sessionId: string, reason: string, status: 'failed' | 'stopped' = 'stopped') {
    const preview = this.previews.get(sessionId)
    if (!preview) return false
    preview.stopping = { status, reason }
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
    const command = input.command.trim()
    if (!command) throw new Error('Give the command that starts the app')
    const dir = resolve(seat.workDir, input.cwd ?? '.')
    const cwd = relative(seat.workDir, dir)
    if (cwd === '..' || cwd.startsWith(`..${sep}`))
      throw new Error('cwd must be inside your working directory')
    const ports = [...new Set((input.ports ?? []).filter((p) => p !== input.port))]
    const all = [input.port, ...ports]

    // One preview per thread: a new one replaces it, which frees its ports.
    await this.stop(seat.sessionId, 'Replaced by a new preview')
    for (const port of all) {
      if (await answers(port))
        throw new Error(
          `Port ${port} is already in use on this computer, by another thread's preview or a ` +
            'process you started. Stop that process, or run the app on another port.',
        )
    }

    const origins = this.options.expose
      ? await this.options.expose(seat.sessionId, all)
      : Object.fromEntries(all.map((p) => [p, `http://localhost:${p}`]))
    const env = harnessEnv({
      ...(seat.runAs
        ? {
            HOME: teammateHome(seat.runAs),
            USER: seat.runAs,
            LOGNAME: seat.runAs,
          }
        : {}),
      PORT: String(input.port),
      // Reachable from the provider's proxy, not only from this computer.
      HOST: '0.0.0.0',
      BRIGADE_PREVIEW_URL: origins[input.port]!,
      ...Object.fromEntries(all.map((p) => [`BRIGADE_PREVIEW_URL_${p}`, origins[p]!])),
    })

    // As the teammate on a cloud computer. The wrapper prints its pid first, to find its group.
    const script = 'cd -- "$0" || exit 1; echo "$$"; exec sh -c "$1"'
    const child = seat.runAs
      ? spawn('sudo', ['-n', '-E', '-u', seat.runAs, '--', 'sh', '-c', script, dir, command], {
          cwd: '/',
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        })
      : spawn('sh', ['-c', script, dir, command], {
          cwd: '/',
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        })

    const preview: Preview = {
      info: {
        previewId: randomUUID(),
        status: 'starting',
        command,
        cwd,
        port: input.port,
        ports,
      },
      seat,
      input,
      child,
      lines: [],
      partial: '',
      lastUsed: Date.now(),
      exited: new Promise((done) => {
        child.once('error', () => done(null))
        child.once('close', (code) => done(code))
      }),
    }
    this.previews.set(seat.sessionId, preview)
    this.report(preview)

    let pidLine = true
    child.stdout!.on('data', (data: Buffer) => {
      let text = data.toString('utf8')
      if (pidLine) {
        const newline = text.indexOf('\n')
        if (newline < 0) return
        pidLine = false
        void this.findGroup(preview, Number(text.slice(0, newline)))
        text = text.slice(newline + 1)
      }
      this.append(preview, text)
    })
    child.stderr!.on('data', (data: Buffer) => this.append(preview, data.toString('utf8')))
    void preview.exited.then((code) => {
      if (this.previews.get(seat.sessionId) !== preview) return
      if (preview.stopping)
        return this.ended(preview, preview.stopping.status, preview.stopping.reason)
      const how = code === null ? 'could not start' : `exited with code ${code}`
      this.ended(
        preview,
        'failed',
        preview.info.status === 'running' ? `The app stopped: it ${how}` : `The command ${how}`,
      )
    })

    // Wait for the port to answer, the process to end, or the time to run out.
    const waitMs = Math.min(input.timeoutMs ?? PREVIEW_START_MS, PREVIEW_START_MAX_MS)
    const deadline = Date.now() + waitMs
    while (this.previews.get(seat.sessionId) === preview && preview.info.status === 'starting') {
      if (await answers(input.port)) {
        preview.info = { ...preview.info, status: 'running' }
        this.report(preview)
        break
      }
      if (signal?.aborted) {
        await this.stop(seat.sessionId, 'The turn was interrupted while the app started')
        break
      }
      if (Date.now() > deadline) {
        await this.stop(
          seat.sessionId,
          `Nothing answered on port ${input.port} within ${Math.round(waitMs / 1000)} seconds`,
          'failed',
        )
        break
      }
      await sleep(500)
    }

    const result: PreviewResult = { status: preview.info.status, origins }
    if (preview.info.reason) result.reason = preview.info.reason
    if (preview.info.status !== 'running') result.logs = this.tail(preview, 60)
    return result
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

  private kill(preview: Preview, signal: 'TERM' | 'KILL') {
    const group = preview.group
    if (!group) {
      preview.child.kill(signal === 'TERM' ? 'SIGTERM' : 'SIGKILL')
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
    for (const line of lines) preview.lines.push(line.slice(0, LINE_MAX))
    if (preview.lines.length > PREVIEW_LOG_LINES)
      preview.lines.splice(0, preview.lines.length - PREVIEW_LOG_LINES)
  }

  private tail(preview: Preview, lines = PREVIEW_LOG_LINES) {
    const all = preview.partial ? [...preview.lines, preview.partial] : preview.lines
    return all.slice(-lines).join('\n')
  }

  private ended(preview: Preview, status: 'failed' | 'stopped', reason: string) {
    this.previews.delete(preview.seat.sessionId)
    preview.info = { ...preview.info, status, reason }
    this.report(preview)
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
      if (now - preview.lastUsed >= TTL_MS)
        void this.stop(
          sessionId,
          `Stopped after ${Math.round(TTL_MS / 60_000)} minutes without use. Ask to start it again.`,
        )
    }
  }
}
