import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Everything the runner keeps on this computer lives here. */
export const HOME = process.env.BRIGADE_HOME ?? join(homedir(), '.brigade')
export const VERSION = '0.0.0'
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
