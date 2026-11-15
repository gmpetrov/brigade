// Brigade Computer Use.app (apps/computer-use-macos), shipped inside Brigade.app on macOS:
// it holds Screen Recording and Accessibility. Asked over its socket (the runner's protocol,
// apps/runner/src/computer-use.ts) and started in the background when it isn't running.
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type Permissions = { screen: boolean; accessibility: boolean }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Its reply: ok with a result, or the error it answered with. */
type Reply = { ok: true; result: Record<string, unknown> } | { ok: false; message: string }

export class Helper {
  private lastLaunch = 0

  /** `app`: the helper's bundle, when this build ships it. */
  constructor(readonly app: string | undefined) {}

  static find(resources: string) {
    const app = join(resources, 'Brigade Computer Use.app')
    return process.platform === 'darwin' && existsSync(app) ? app : undefined
  }

  /** Quits a helper still running from before this launch, e.g. from the copy an update
   * replaced, so the next request starts the one inside this Brigade.app with a fresh view of
   * its permissions. It holds no state worth keeping; the runner starts it on demand. */
  restart() {
    if (!this.app) return
    execFile('pkill', ['-x', 'brigade-computer-use'], () => {})
  }

  /** One request: undefined when the helper can't be reached. */
  request(method: string, params: Record<string, unknown>, waitMs: number) {
    return new Promise<Reply | undefined>((resolve) => {
      const dir = join(process.env.HOME || homedir(), '.brigade', 'computer-use')
      let token: string
      try {
        token = readFileSync(join(dir, 'token'), 'utf8').trim()
      } catch {
        return resolve(undefined)
      }
      const socket = createConnection(join(dir, 'sock'))
      let buffer = ''
      let settled = false
      const finish = (reply: Reply | undefined) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.destroy()
        resolve(reply)
      }
      const timer = setTimeout(() => finish(undefined), waitMs)
      socket.setEncoding('utf8')
      socket.on('connect', () => {
        socket.write(`${JSON.stringify({ id: 1, token, method, params })}\n`)
      })
      socket.on('data', (chunk: string) => {
        buffer += chunk
        const end = buffer.indexOf('\n')
        if (end < 0) return
        try {
          const reply = JSON.parse(buffer.slice(0, end))
          finish(
            reply.ok === true
              ? { ok: true, result: reply.result ?? {} }
              : { ok: false, message: reply.error?.message ?? 'It failed.' },
          )
        } catch {
          finish(undefined)
        }
      })
      socket.on('error', () => finish(undefined))
      socket.on('close', () => finish(undefined))
    })
  }

  private async ask() {
    const reply = await this.request('status', {}, 3_000)
    return reply?.ok ? reply.result : undefined
  }

  /** In the background (-g). Opening it also makes macOS ask for what is missing. */
  launch() {
    if (!this.app) return
    execFile('open', ['-g', '-a', this.app], () => {})
  }

  /** A request that starts the helper first when it isn't running. */
  async call(method: string, params: Record<string, unknown>, waitMs: number) {
    if (!this.app) throw new Error('This build of Brigade has no Brigade Computer Use.')
    const first = await this.request(method, params, waitMs)
    if (first) return unwrap(first)
    this.launch()
    const until = Date.now() + 5_000
    while (Date.now() < until) {
      await sleep(250)
      if (await this.ask()) {
        const reply = await this.request(method, params, waitMs)
        if (!reply) throw new Error('Brigade Computer Use stopped answering.')
        return unwrap(reply)
      }
    }
    throw new Error('Brigade Computer Use did not start. Open Set up Brigade… in the menu.')
  }

  /** Its permissions, as it reports them; undefined while it can't be asked. Starts it at most
   * every 15 seconds, so a helper that won't start isn't opened on every check. */
  async permissions(): Promise<Permissions | undefined> {
    if (!this.app) return undefined
    let result = await this.ask()
    if (!result) {
      if (Date.now() - this.lastLaunch < 15_000) return undefined
      this.lastLaunch = Date.now()
      this.launch()
      const until = Date.now() + 5_000
      while (!result && Date.now() < until) {
        await sleep(250)
        result = await this.ask()
      }
      if (!result) return undefined
    }
    return { screen: result.screenRecording === true, accessibility: result.accessibility === true }
  }
}

function unwrap(reply: Reply) {
  if (!reply.ok) throw new Error(reply.message)
  return reply.result
}
