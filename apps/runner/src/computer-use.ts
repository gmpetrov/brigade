// Computer use on a member's Mac, through Brigade Computer Use.app
// (apps/computer-use-macos). The app holds Screen Recording and Accessibility
// itself: started with `open`, macOS treats it as its own app, not as part of
// the runner or the terminal that started it. It listens on a Unix socket in
// ~/.brigade/computer-use and checks the token it writes beside it.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const COMPUTER_USE_APP = 'Brigade Computer Use.app'
const DIR = join(homedir(), '.brigade', 'computer-use')
/** Longest wait for the app to start listening after `open`. */
const LAUNCH_MS = 15_000
/** Longest a request waits; opening an app can take a while. */
const REQUEST_MS = 60_000

export class ComputerUseError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** The installed helper app, on macOS only: $BRIGADE_COMPUTER_USE_APP, ~/Applications or /Applications. */
export function computerUseApp(): string | undefined {
  if (process.platform !== 'darwin') return
  const candidates = [
    process.env.BRIGADE_COMPUTER_USE_APP,
    join(homedir(), 'Applications', COMPUTER_USE_APP),
    join('/Applications', COMPUTER_USE_APP),
  ]
  return candidates.find((path) => path && existsSync(path))
}

/** Whether the app is not running (no socket, or nothing listening on it). */
const notRunning = (error: unknown) =>
  ['ENOENT', 'ECONNREFUSED', 'ECONNRESET'].includes((error as NodeJS.ErrnoException).code ?? '')

export class ComputerUseClient {
  private launching: Promise<void> | undefined
  private nextId = 1

  constructor(private readonly app: string) {}

  async request(
    method: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    try {
      return await this.send(method, params, signal)
    } catch (error) {
      if (!notRunning(error)) throw error
      await this.launch()
      return this.send(method, params, signal)
    }
  }

  private launch() {
    this.launching ??= (async () => {
      // -g: in the background, without taking the person's focus.
      await execFileAsync('open', ['-g', '-a', this.app])
      const until = Date.now() + LAUNCH_MS
      for (;;) {
        try {
          await this.send('status', {})
          return
        } catch (error) {
          if (Date.now() > until)
            throw new Error(`${COMPUTER_USE_APP} did not start: ${(error as Error).message}`)
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
      }
    })().finally(() => {
      this.launching = undefined
    })
    return this.launching
  }

  private async send(method: string, params: Record<string, unknown>, signal?: AbortSignal) {
    const token = (await readFile(join(DIR, 'token'), 'utf8')).trim()
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const socket = createConnection(join(DIR, 'sock'))
      let buffer = ''
      const finish = (error: Error | undefined, value?: unknown) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', aborted)
        socket.destroy()
        if (error) reject(error)
        else resolve(value)
      }
      const aborted = () => finish(new Error('aborted'))
      const timer = setTimeout(
        () => finish(new Error(`${COMPUTER_USE_APP} did not answer ${method} in time`)),
        REQUEST_MS,
      )
      signal?.addEventListener('abort', aborted, { once: true })
      socket.on('error', (error) => finish(error))
      socket.on('connect', () => socket.write(`${JSON.stringify({ id, token, method, params })}\n`))
      socket.on('data', (data) => {
        buffer += data.toString('utf8')
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        let reply: { ok?: boolean; result?: unknown; error?: { code?: string; message?: string } }
        try {
          reply = JSON.parse(buffer.slice(0, newline))
        } catch {
          return finish(new Error(`${COMPUTER_USE_APP} sent an unreadable reply`))
        }
        if (reply.ok) finish(undefined, reply.result)
        else
          finish(
            new ComputerUseError(
              reply.error?.code ?? 'failed',
              reply.error?.message ?? `${method} failed`,
            ),
          )
      })
    })
  }
}

let shared: ComputerUseClient | undefined

/** One client for the runner's threads, when the app is installed on this Mac. */
export function computerUseClient(): ComputerUseClient | undefined {
  const app = computerUseApp()
  if (!app) return
  shared ??= new ComputerUseClient(app)
  return shared
}
