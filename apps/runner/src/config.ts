import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, unlinkSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
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

/** The OS's own ID of this machine, read from the output of the command that shows it. */
export function parseMachineId(platform: NodeJS.Platform, output: string): string | undefined {
  const id =
    platform === 'darwin'
      ? /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(output)?.[1]
      : platform === 'win32'
        ? /MachineGuid\s+REG_SZ\s+(\S+)/.exec(output)?.[1]
        : output.trim().split('\n')[0]?.trim()
  return id || undefined
}

function platformMachineId(): string | undefined {
  try {
    if (process.platform === 'darwin')
      return parseMachineId(
        'darwin',
        execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8' }),
      )
    if (process.platform === 'win32')
      return parseMachineId(
        'win32',
        execFileSync(
          'reg',
          ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
          { encoding: 'utf8' },
        ),
      )
    for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      try {
        const id = parseMachineId(process.platform, readFileSync(file, 'utf8'))
        if (id) return id
      } catch {}
    }
  } catch {}
  return undefined
}

/**
 * This machine and runner home, hashed: linking again from the same place keeps its computer
 * even when runner.json is gone, while another machine, or another BRIGADE_HOME with its own
 * thread folders, is a computer of its own. Unset when the OS does not say.
 */
export function machineId(): string | undefined {
  const id = platformMachineId()
  return id
    ? createHash('sha256')
        .update(`brigade-machine\n${id}\n${resolve(HOME)}`)
        .digest('hex')
    : undefined
}

export type RunnerConfig = {
  apiUrl: string
  token: string
  computerId: string
  workspaceName: string
  /** Its workspace, as the API's welcome says: its connection names it to reach the workspace's hub. */
  workspaceId?: string
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
