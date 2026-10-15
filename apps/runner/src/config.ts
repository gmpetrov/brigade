import { execFileSync } from 'node:child_process'
import { readFileSync, unlinkSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Everything the runner keeps on this computer lives here. */
export const HOME = process.env.BRIGADE_HOME ?? join(homedir(), '.brigade')
/**
 * What the dashboard shows as the runner's version: the start of the SHA-256 of the
 * bundle it was installed from (install.sh writes it beside dist/), or "dev" from source.
 */
export const VERSION = (() => {
  try {
    const sha = readFileSync(fileURLToPath(new URL('../.bundle-sha256', import.meta.url)), 'utf8')
    return sha.trim().slice(0, 7) || 'dev'
  } catch {
    return 'dev'
  }
})()
/** A workspace cloud computer: each teammate runs as its own Linux user. */
export const CLOUD = process.env.BRIGADE_CLOUD === '1' || process.argv.includes('--cloud')
/** Account login directories. Shared with teammate users on a cloud computer. */
export const ACCOUNTS_DIR = process.env.BRIGADE_ACCOUNTS_DIR ?? join(HOME, 'accounts')

export type RunnerConfig = {
  apiUrl: string
  token: string
  computerId: string
  workspaceName: string
}

const CONFIG = join(HOME, 'runner.json')

export async function loadConfig(): Promise<RunnerConfig | null> {
  try {
    return JSON.parse(await readFile(CONFIG, 'utf8')) as RunnerConfig
  } catch {
    return null
  }
}

export async function saveConfig(config: RunnerConfig) {
  await mkdir(HOME, { recursive: true, mode: 0o700 })
  await writeFile(CONFIG, JSON.stringify(config, null, 2), { mode: 0o600 })
}

export const paths = {
  outbox: join(HOME, 'outbox'),
  state: join(HOME, 'state'),
  threadDir: (teammateId: string, sessionId: string) =>
    join(HOME, 'teammates', teammateId, 'threads', sessionId),
}

/** Exit code of a runner that found another running from the same home (Brigade.app shows it). */
export const ALREADY_RUNNING_EXIT_CODE = 3

const PID_FILE = join(HOME, 'runner.pid')

/** Whether pid is a live Node.js process: a pid left by a crash may since belong to something else. */
function liveRunner(pid: number) {
  try {
    process.kill(pid, 0)
    const command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
    return /node|tsx/.test(command)
  } catch {
    return false
  }
}

/**
 * One runner per home: two would answer the same computer's messages. Returns
 * the pid of the runner already running, or claims runner.pid for this one.
 */
export async function claimRunner(): Promise<number | null> {
  const other = Number((await readFile(PID_FILE, 'utf8').catch(() => '')).trim())
  if (other && other !== process.pid && liveRunner(other)) return other
  await mkdir(HOME, { recursive: true, mode: 0o700 })
  await writeFile(PID_FILE, String(process.pid))
  process.on('exit', () => {
    try {
      if (readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) unlinkSync(PID_FILE)
    } catch {}
  })
  return null
}
