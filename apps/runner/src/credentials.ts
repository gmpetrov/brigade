// A thread's use of the vault's credentials. The API releases a secret to this
// runner, never to the model: a website login is typed into the teammate's
// browser by credential-fill, any other kind is written to a private env file
// the thread's commands can load. Env files are removed when the thread parks.
import { spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CredentialSecret, CredentialSummary, CredentialUse } from '@brigade/contracts'
import { HOME } from './config.js'
import { teammateHome } from './teammates.js'

/** Asks the API; the call that made it is shown to the person when an approval is needed. */
export type CredentialRequester = (request: {
  action: 'list' | 'release'
  credentialId?: string
  use?: CredentialUse
  purpose?: string
  toolCallId: string
  toolName: string
  input: unknown
}) => Promise<unknown>

type Call = { toolCallId: string; toolName: string; input: unknown }

const here = fileURLToPath(import.meta.url)
const FILL = join(dirname(here), `credential-fill${extname(here)}`)

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'credential'

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

const SCHEMES = { postgres: 'postgresql', mysql: 'mysql', mongodb: 'mongodb' } as const

/** The variables a credential becomes. A website login never does. */
export function envFor(
  credential: CredentialSummary,
  secret: CredentialSecret,
): Record<string, string> {
  const d = credential.details
  const env: Record<string, string | undefined> = {}
  if (credential.kind === 'database') {
    Object.assign(env, {
      DB_HOST: d.host,
      DB_PORT: d.port?.toString(),
      DB_NAME: d.database,
      DB_USER: d.username,
      DB_PASSWORD: secret.password,
    })
    const scheme = d.engine && d.engine !== 'other' ? SCHEMES[d.engine] : undefined
    if (scheme && d.host) {
      const auth = d.username
        ? `${encodeURIComponent(d.username)}${secret.password ? `:${encodeURIComponent(secret.password)}` : ''}@`
        : ''
      env.DATABASE_URL = `${scheme}://${auth}${d.host}${d.port ? `:${d.port}` : ''}/${encodeURIComponent(d.database ?? '')}`
    }
    if (d.engine === 'postgres')
      Object.assign(env, {
        PGHOST: d.host,
        PGPORT: d.port?.toString(),
        PGDATABASE: d.database,
        PGUSER: d.username,
        PGPASSWORD: secret.password,
      })
  } else if (credential.kind === 'api_key') {
    Object.assign(env, { API_KEY: secret.apiKey, API_URL: d.url })
  } else if (credential.kind === 'other') {
    env.SECRET = secret.value
  }
  return Object.fromEntries(
    Object.entries(env).filter((e): e is [string, string] => typeof e[1] === 'string'),
  )
}

/** Run a command as the teammate's user (or as this user), with `stdin`; resolves its stdout. */
function run(command: string, args: string[], stdin: string, runAs?: string) {
  const [file, argv] = runAs ? ['sudo', ['-n', '-u', runAs, command, ...args]] : [command, args]
  return new Promise<string>((resolve, reject) => {
    const child = spawn(file, argv, { cwd: '/', stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `exit ${code}`)),
    )
    child.stdin.end(stdin)
  })
}

export class ThreadCredentials {
  constructor(
    private readonly options: {
      sessionId: string
      request: CredentialRequester
      /** On a cloud computer: the teammate's Linux user. */
      runAs?: string
      /** The teammate's browser, when it has one: its debugging port and this thread's tabs. */
      browser?: { port: number; tabsFile: string }
    },
  ) {}

  get canFill() {
    return Boolean(this.options.browser && this.options.runAs)
  }

  /** Where this thread's env files live: outside its working directory, so never committed. */
  private get dir() {
    const { runAs, sessionId } = this.options
    return runAs
      ? `${teammateHome(runAs)}/.credentials/${sessionId}`
      : join(HOME, 'credentials', sessionId)
  }

  async list(call: Call) {
    return (await this.options.request({ action: 'list', ...call })) as CredentialSummary[]
  }

  private async release(credentialId: string, use: CredentialUse, call: Call, purpose?: string) {
    return (await this.options.request({
      action: 'release',
      credentialId,
      use,
      ...(purpose ? { purpose } : {}),
      ...call,
    })) as { credential: CredentialSummary; secret: CredentialSecret }
  }

  /** Write a credential to a private env file. Returns where, and its variable names. */
  async env(credentialId: string, call: Call) {
    const { credential, secret } = await this.release(credentialId, 'env', call)
    const vars = envFor(credential, secret)
    const file = join(this.dir, `${slug(credential.name)}.env`)
    const text = `${Object.entries(vars)
      .map(([k, v]) => `export ${k}=${quote(v)}`)
      .join('\n')}\n`
    const { runAs } = this.options
    if (runAs) {
      // Owned by the teammate's user, readable by it alone.
      await run(
        'sh',
        ['-c', 'umask 077 && mkdir -p "$1" && cat > "$2"', 'sh', this.dir, file],
        text,
        runAs,
      )
    } else {
      await mkdir(this.dir, { recursive: true, mode: 0o700 })
      await writeFile(file, text, { mode: 0o600 })
    }
    return { credential, file, variables: Object.keys(vars) }
  }

  /** Sign in with a website login on the thread's tab of that site. */
  async fill(credentialId: string, submit: boolean, call: Call) {
    const { browser, runAs } = this.options
    if (!browser || !runAs)
      throw new Error('This teammate has no browser here; website logins work on cloud computers.')
    // Find the credential's site, and check a tab is on it, before asking anyone.
    const known = (await this.list(call)).find((c) => c.id === credentialId)
    if (!known) throw new Error('No such credential. List them with list_credentials.')
    if (known.kind !== 'website' || !known.details.url)
      throw new Error(`${known.name} is not a website login: use use_credential.`)
    const host = new URL(known.details.url).hostname
    const helper = (input: object) =>
      run(
        process.execPath,
        [FILL, String(browser.port), browser.tabsFile],
        JSON.stringify(input),
        runAs,
      ).then(
        (stdout) =>
          JSON.parse(stdout) as {
            ok: boolean
            url?: string
            fields?: string[]
            filled?: string[]
            submitted?: boolean
            error?: string
          },
      )
    const check = await helper({ host, check: true })
    if (!check.ok) throw new Error(check.error)
    if (!check.fields?.length)
      throw new Error(`No sign-in field on ${check.url}. Go to the sign-in form first.`)

    const { credential, secret } = await this.release(
      credentialId,
      'browser',
      call,
      `The login goes into ${check.url}.`,
    )
    // The vault's own URL decides where the password may go, not the earlier listing.
    const result = await helper({
      host: new URL(credential.details.url!).hostname,
      username: credential.details.username,
      password: secret.password,
      submit,
    })
    if (!result.ok) throw new Error(result.error)
    return { credential, url: result.url, filled: result.filled, submitted: result.submitted }
  }

  /** Remove the thread's env files. */
  async cleanup() {
    const { runAs } = this.options
    if (runAs) await run('rm', ['-rf', this.dir], '', runAs).catch(() => undefined)
    else await rm(this.dir, { recursive: true, force: true })
  }
}
