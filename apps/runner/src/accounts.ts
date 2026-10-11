// Harness logins on this computer. Brigade runs the vendor's own login command
// into a config directory per account, and never reads what it writes there,
// with one exception. On a workspace computer several teammate users share a
// Claude account, and Claude's own login refreshes by rotating its refresh
// token, so the first teammate to refresh would sign the others out. There a
// Claude account is a long-lived token from `claude setup-token`, which the
// runner keeps beside the config directory and hands to each turn.
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AccountRef } from '@brigade/contracts'
import xterm from '@xterm/headless'
import { ACCOUNTS_DIR, CLOUD } from './config.js'
import { shareAccount } from './teammates.js'
import { harnessEnv } from './harness/env.js'

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/
const LOGIN_TIMEOUT_MS = 15 * 60_000
/** Where a Claude account's token lives, readable only by the runner. */
const TOKEN_FILE = '.oauth-token'
const TOKEN = /sk-ant-oat\d+-[A-Za-z0-9_-]{20,}/
const AUTHORIZE_URL = /https:\/\/\S+\/oauth\/authorize\?\S+/
/** setup-token's pseudo-terminal: wide enough that its URL and token stay on one line. */
const COLS = 1000
const ROWS = 50

/** The config directory of a Brigade-signed-in account; null for the machine's own login. */
export function accountDir(account: AccountRef): string | null {
  if (account.source === 'machine') return null
  if (!SAFE_ID.test(account.id)) throw new Error('Invalid account id')
  return join(ACCOUNTS_DIR, account.id)
}

/** The account's config directory, as the vendor CLI expects it. */
function configEnv(account: AccountRef): Record<string, string> {
  const dir = accountDir(account)
  if (!dir) return {}
  return account.provider === 'codex' ? { CODEX_HOME: dir } : { CLAUDE_CONFIG_DIR: dir }
}

/**
 * A Claude account's long-lived token, for a turn on it. None when its login
 * is in the config directory (a member's machine, or signed in before tokens).
 */
export function accountToken(account: AccountRef): Record<string, string> {
  const dir = accountDir(account)
  if (!dir || account.provider === 'codex') return {}
  try {
    const token = readFileSync(join(dir, TOKEN_FILE), 'utf8').trim()
    return token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {}
  } catch {
    return {}
  }
}

/** Environment that points a harness at the account's login. */
export function accountEnv(account: AccountRef): Record<string, string> {
  return { ...configEnv(account), ...accountToken(account) }
}

/** Terminal output as text: links and colours dropped, cursor moves kept as spaces and line breaks. */
const strip = (text: string) =>
  text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC: hyperlinks, titles
    .replace(/\x1b\[(\d*)C/g, (_, n: string) => ' '.repeat(Math.min(Number(n) || 1, 200)))
    .replace(/\x1b\[[0-9;?]*[ABEFGHJKdf]/g, '\n')
    .replace(/\x1b\[[0-9;?<=>]*[A-Za-z]/g, '') // colours and modes
    .replace(/\x1b[78]/g, '')
    .replace(/\r/g, '')

/** Never let a token reach an error message. */
const redact = (text: string) => text.replace(/sk-ant-[A-Za-z0-9_-]+/g, '[token]')

/**
 * A terminal UI's screen, rebuilt from its output. It redraws only the cells
 * that change, so its text cannot be read from the output itself.
 */
class Screen {
  // Reading the buffer is a "proposed" API in the headless build.
  private term = new xterm.Terminal({
    cols: COLS,
    rows: ROWS,
    scrollback: 1000,
    allowProposedApi: true,
  })
  private writing = Promise.resolve()

  write(data: Uint8Array) {
    this.writing = this.writing.then(() => new Promise<void>((done) => this.term.write(data, done)))
  }

  /** Its lines, once everything written so far is drawn. */
  async lines() {
    await this.writing
    const buffer = this.term.buffer.active
    return Array.from(
      { length: buffer.length },
      (_, i) => buffer.getLine(i)?.translateToString(true).trim() ?? '',
    )
  }
}

/** The first match of a pattern on any line. */
const find = (lines: string[], pattern: RegExp) =>
  lines.map((line) => line.match(pattern)).find(Boolean)

type Prompt = { url: string; userCode?: string; flow: 'paste' | 'device' }
type Done = { ok: boolean; error?: string; email?: string; plan?: string }

/** One running vendor login. */
class Login {
  private child: ChildProcess
  private raw = ''
  private prompted = false
  /** Signing in for a token (a Claude account on a workspace computer): its screen. */
  private readonly screen: Screen | undefined
  private quiet: NodeJS.Timeout | undefined
  private due: NodeJS.Timeout | undefined
  private token: string | undefined
  private timer: NodeJS.Timeout

  constructor(
    readonly account: AccountRef,
    private readonly dir: string,
    private readonly onPrompt: (prompt: Prompt) => void,
    private readonly onDone: (done: Done) => void,
  ) {
    if (account.provider !== 'codex' && CLOUD) this.screen = new Screen()
    const [command, args]: [string, string[]] =
      account.provider === 'codex'
        ? ['codex', ['login', '--device-auth']]
        : this.screen
          ? // A terminal UI, so in a pseudo-terminal.
            [
              'script',
              ['-qefc', `stty cols ${COLS} rows ${ROWS}; exec claude setup-token`, '/dev/null'],
            ]
          : ['claude', ['auth', 'login', '--claudeai']]
    this.child = spawn(command, args, {
      env: harnessEnv({ ...configEnv(account), BROWSER: 'false' }),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout!.on('data', (d) => this.read(d))
    this.child.stderr!.on('data', (d) => this.read(d))
    this.child.on('error', (error) =>
      this.finish({ ok: false, error: `Could not run ${command}: ${error.message}` }),
    )
    this.child.on('close', (code) => void this.closed(code))
    this.timer = setTimeout(() => this.cancel('Sign-in timed out'), LOGIN_TIMEOUT_MS)
  }

  /** Pass the code from the vendor's page to the login command. Never stored. */
  submit(code: string) {
    const clean = code.replace(/\s+/g, '')
    if (!this.screen) {
      this.child.stdin?.write(clean + '\n')
      return
    }
    // The terminal UI takes the code as typed text, then Enter on its own.
    this.child.stdin?.write(clean)
    setTimeout(() => this.child.stdin?.write('\r'), 300)
  }

  /** Stop it. A sign-in that gives way to a newer one leaves the directory to it. */
  cancel(reason = 'Cancelled', keepDir = false) {
    this.child.kill()
    this.finish({ ok: false, error: reason }, keepDir)
  }

  private read(chunk: Buffer) {
    if (this.screen) {
      this.screen.write(chunk)
      // Look once it holds still (a line may be half drawn before), or every few seconds while it animates.
      clearTimeout(this.quiet)
      this.quiet = setTimeout(() => void this.look(), 400)
      this.due ??= setTimeout(() => void this.look(), 3000)
      return
    }
    this.raw = (this.raw + chunk.toString()).slice(-16000)
    if (this.prompted) return
    const output = strip(this.raw)
    if (this.account.provider === 'codex') {
      const url = output.match(/https:\/\/auth\.openai\.com\/\S+/)?.[0]
      const code = output.match(/\b[A-Z0-9]{4,5}-[A-Z0-9]{4,6}\b/)?.[0]
      if (url && code) {
        this.prompted = true
        this.onPrompt({ url, userCode: code, flow: 'device' })
      }
    } else {
      const url = output.match(AUTHORIZE_URL)?.[0]
      if (url) {
        this.prompted = true
        this.onPrompt({ url, flow: 'paste' })
      }
    }
  }

  /** What setup-token shows: its sign-in URL, then the token, or an error. */
  private async look() {
    clearTimeout(this.quiet)
    clearTimeout(this.due)
    this.due = undefined
    if (this.finished || !this.screen) return
    const lines = await this.screen.lines()
    if (this.finished) return
    // A failed step (often a wrong or expired code) waits for Enter to retry: stop here instead.
    const error = find(lines, /OAuth error: *(.+)/)?.[1]
    if (error) return this.cancel(redact(`Claude sign-in failed: ${error}`).slice(0, 300))
    if (!this.prompted) {
      const url = find(lines, AUTHORIZE_URL)?.[0]
      if (url) {
        this.prompted = true
        this.onPrompt({ url, flow: 'paste' })
      }
      return
    }
    const token = find(lines, TOKEN)?.[0]
    if (token && !this.token) {
      this.token = token
      // It shows the token and exits; stop it if it lingers.
      setTimeout(() => this.child.kill(), 3000)
    }
  }

  private async closed(code: number | null) {
    if (this.finished) return
    if (this.screen) {
      const lines = await this.screen.lines()
      this.token ??= find(lines, TOKEN)?.[0]
      if (this.finished) return
      if (!this.token) {
        const last = lines.filter(Boolean).at(-1) ?? 'Sign-in failed'
        return this.finish({ ok: false, error: redact(last).slice(0, 300) })
      }
      try {
        await this.saveToken(this.token)
      } catch (error) {
        return this.finish({ ok: false, error: `Could not save the sign-in: ${String(error)}` })
      }
      // Inference-only: it cannot tell who it belongs to.
      return this.finish({ ok: true })
    }
    if (code !== 0) return this.finish({ ok: false, error: this.lastLine() })
    if (CLOUD) await shareAccount(this.account.id)
    this.finish({ ok: true, ...(await identity(this.account)) })
  }

  /** Only the runner can read it; a login from before tokens is removed. */
  private async saveToken(token: string) {
    const file = join(this.dir, TOKEN_FILE)
    await writeFile(file, token + '\n', { mode: 0o600 })
    await chmod(file, 0o600)
    await rm(join(this.dir, '.credentials.json'), { force: true })
  }

  private lastLine() {
    const last = strip(this.raw)
      .split('\n')
      .filter((l) => l.trim())
      .at(-1)
    return redact(last?.trim() ?? 'Sign-in failed').slice(0, 300)
  }

  private finished = false
  private finish(done: Done, keepDir = false) {
    if (this.finished) return
    this.finished = true
    clearTimeout(this.timer)
    clearTimeout(this.quiet)
    clearTimeout(this.due)
    this.onDone(done)
    if (!done.ok && !keepDir) void rm(this.dir, { recursive: true, force: true })
  }
}

/** Who the account is signed in as, from the CLI's own status command. Never the credential. */
async function identity(account: AccountRef): Promise<{ email?: string; plan?: string }> {
  if (account.provider === 'codex') return {}
  const out = await run('claude', ['auth', 'status', '--json'], configEnv(account))
  try {
    const status = JSON.parse(out) as {
      loggedIn?: boolean
      email?: string
      subscriptionType?: string
    }
    return {
      ...(status.email ? { email: status.email } : {}),
      ...(status.subscriptionType ? { plan: status.subscriptionType } : {}),
    }
  } catch {
    return {}
  }
}

/** Whether this machine's own logins exist, for the accounts already on a member's machine. */
export async function machineLogins(): Promise<
  { provider: 'claude_code' | 'codex'; loggedIn: boolean; email?: string; plan?: string }[]
> {
  const claude = await run('claude', ['auth', 'status', '--json'], {}).then(
    (out) => JSON.parse(out) as { loggedIn?: boolean; email?: string; subscriptionType?: string },
    () =>
      ({ loggedIn: false }) as { loggedIn?: boolean; email?: string; subscriptionType?: string },
  )
  const codex = await run('codex', ['login', 'status'], {}).then(
    (out) => /logged in/i.test(out) && !/not logged in/i.test(out),
    () => false,
  )
  return [
    {
      provider: 'claude_code',
      loggedIn: claude.loggedIn === true,
      ...(claude.email ? { email: claude.email } : {}),
      ...(claude.subscriptionType ? { plan: claude.subscriptionType } : {}),
    },
    { provider: 'codex', loggedIn: codex },
  ]
}

function run(command: string, args: string[], env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: harnessEnv(env), stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('error', reject)
    child.on('close', () => resolve(out))
  })
}

export class Accounts {
  private logins = new Map<string, Login>()

  constructor(
    private readonly send: {
      prompt: (loginId: string, prompt: Prompt) => void
      done: (loginId: string, done: Done) => void
    },
  ) {}

  async start(loginId: string, account: AccountRef) {
    const dir = accountDir(account)
    if (!dir) throw new Error("The machine's own login is managed on the machine")
    // A sign-in the API lost (it restarted) would otherwise time out later and delete this one's login.
    for (const login of this.logins.values())
      if (login.account.id === account.id) login.cancel('Replaced by a new sign-in', true)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const login = new Login(
      account,
      dir,
      (prompt) => this.send.prompt(loginId, prompt),
      (done) => {
        this.logins.delete(loginId)
        this.send.done(loginId, done)
      },
    )
    this.logins.set(loginId, login)
  }

  /** A sign-in is in progress. */
  get busy() {
    return this.logins.size > 0
  }

  submit(loginId: string, code: string) {
    const login = this.logins.get(loginId)
    if (!login) throw new Error('No sign-in is waiting for a code')
    login.submit(code)
  }

  cancel(loginId: string) {
    this.logins.get(loginId)?.cancel()
  }

  /** Sign out with the vendor's command, then delete the account's directory (and its token). */
  async remove(account: AccountRef) {
    const dir = accountDir(account)
    if (!dir) return // never sign the member's own machine login out
    await run(
      account.provider === 'codex' ? 'codex' : 'claude',
      account.provider === 'codex' ? ['logout'] : ['auth', 'logout'],
      configEnv(account),
    ).catch(() => '')
    await rm(dir, { recursive: true, force: true })
  }
}
