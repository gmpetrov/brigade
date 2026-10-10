// Harness logins on this computer. Brigade runs the vendor's own login command
// into a config directory per account, and never reads what it writes there.
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { AccountRef } from '@brigade/contracts'
import { ACCOUNTS_DIR, CLOUD } from './config.js'
import { shareAccount } from './teammates.js'
import { harnessEnv } from './harness/env.js'

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/
const LOGIN_TIMEOUT_MS = 15 * 60_000

/** The config directory of a Brigade-signed-in account; null for the machine's own login. */
export function accountDir(account: AccountRef): string | null {
  if (account.source === 'machine') return null
  if (!SAFE_ID.test(account.id)) throw new Error('Invalid account id')
  return join(ACCOUNTS_DIR, account.id)
}

/** Environment that points a harness at the account's login. */
export function accountEnv(account: AccountRef): Record<string, string> {
  const dir = accountDir(account)
  if (!dir) return {}
  return account.provider === 'codex' ? { CODEX_HOME: dir } : { CLAUDE_CONFIG_DIR: dir }
}

const strip = (text: string) =>
  text
    .replace(/\x1b\]8;;.*?(?:\x07|\x1b\\)/g, '') // OSC 8 hyperlinks
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '') // colours and cursor moves

type Prompt = { url: string; userCode?: string; flow: 'paste' | 'device' }
type Done = { ok: boolean; error?: string; email?: string; plan?: string }

/** One running vendor login. */
class Login {
  private child: ChildProcess
  private output = ''
  private prompted = false
  private timer: NodeJS.Timeout

  constructor(
    private readonly account: AccountRef,
    private readonly dir: string,
    private readonly onPrompt: (prompt: Prompt) => void,
    private readonly onDone: (done: Done) => void,
  ) {
    const [command, ...args] =
      account.provider === 'codex'
        ? ['codex', 'login', '--device-auth']
        : ['claude', 'auth', 'login', '--claudeai']
    this.child = spawn(command!, args, {
      env: harnessEnv({ ...accountEnv(account), BROWSER: 'false' }),
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
    this.child.stdin?.write(code.replace(/\s+/g, '') + '\n')
  }

  cancel(reason = 'Cancelled') {
    this.child.kill()
    this.finish({ ok: false, error: reason })
  }

  private read(chunk: Buffer) {
    this.output = (this.output + strip(chunk.toString())).slice(-8000)
    if (this.prompted) return
    if (this.account.provider === 'codex') {
      const url = this.output.match(/https:\/\/auth\.openai\.com\/\S+/)?.[0]
      const code = this.output.match(/\b[A-Z0-9]{4,5}-[A-Z0-9]{4,6}\b/)?.[0]
      if (url && code) {
        this.prompted = true
        this.onPrompt({ url, userCode: code, flow: 'device' })
      }
    } else {
      const url = this.output.match(/https:\/\/\S+\/oauth\/authorize\?\S+/)?.[0]
      if (url) {
        this.prompted = true
        this.onPrompt({ url, flow: 'paste' })
      }
    }
  }

  private async closed(code: number | null) {
    if (code !== 0) {
      const last = this.output.trim().split('\n').filter(Boolean).at(-1) ?? 'Sign-in failed'
      return this.finish({ ok: false, error: last.slice(0, 300) })
    }
    if (CLOUD) await shareAccount(this.account.id)
    this.finish({ ok: true, ...(await identity(this.account)) })
  }

  private finished = false
  private finish(done: Done) {
    if (this.finished) return
    this.finished = true
    clearTimeout(this.timer)
    this.onDone(done)
    if (!done.ok) void rm(this.dir, { recursive: true, force: true })
  }
}

/** Who the account is signed in as, from the CLI's own status command. Never the credential. */
async function identity(account: AccountRef): Promise<{ email?: string; plan?: string }> {
  if (account.provider === 'codex') return {}
  const out = await run('claude', ['auth', 'status', '--json'], accountEnv(account))
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
    await mkdir(dir, { recursive: true, mode: 0o700 })
    this.logins.get(loginId)?.cancel()
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

  /** Sign out with the vendor's command, then delete the account's directory. */
  async remove(account: AccountRef) {
    const dir = accountDir(account)
    if (!dir) return // never sign the member's own machine login out
    await run(
      account.provider === 'codex' ? 'codex' : 'claude',
      account.provider === 'codex' ? ['logout'] : ['auth', 'logout'],
      accountEnv(account),
    ).catch(() => '')
    await rm(dir, { recursive: true, force: true })
  }
}
