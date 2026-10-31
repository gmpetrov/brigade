// What teammates' turns spend, read from the harness's own session logs on this computer
// (usage-scan.ts) rather than from the turn's stream: each model response once, by its id, with
// its model and final counts, a subagent's included, and those of a turn cut short. The stream's
// totals counted a turn split by background work twice and missed subagents (Settings › Usage).
// Read after each turn and every few minutes, from where each log was read up to; what was read
// is moved past once the API kept it, so a stop or a lost connection only sends some again.
import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LoggedResponse, LOGGED_RESPONSES_MAX } from '@brigade/contracts'
import { ACCOUNTS_DIR, CLOUD, HOME } from './config.js'
import { teammateHome, teammateUser } from './teammates.js'
import {
  projectFolder,
  type LogMark,
  type ScanInput,
  type ScanOutput,
  type ScannedResponse,
} from './usage-scan.js'

const SCAN = join(
  dirname(fileURLToPath(import.meta.url)),
  `usage-scan${extname(fileURLToPath(import.meta.url))}`,
)
/** Every log on the computer is looked at this often, for what came after its turn. */
const SWEEP_MS = 10 * 60_000
/** A turn's log is read this long after it ends: the harness writes its last lines meanwhile. */
const AFTER_TURN_MS = 5_000
/** Most responses one scan reads before they are sent. */
const SCAN_MAX = 5_000
const SCAN_TIMEOUT_MS = 5 * 60_000
const OUTPUT_MAX = 64 * 1024 * 1024

/** Where the logs are, and whose thread a project folder is. */
export type LogSource = {
  /** On a cloud computer: the teammate's user, which reads its own logs. */
  runAs?: string
  input: Omit<ScanInput, 'offsets' | 'max'>
  threadOf: (folder: string) => { sessionId: string; teammateId: string } | undefined
}

/** Brigade's folder, as Claude Code sees it: it names project folders after the real path. */
const home = (() => {
  try {
    return realpathSync(HOME)
  } catch {
    return HOME
  }
})()

/** On a member's machine: thread folders are HOME/teammates/<teammate>/threads/<thread>. */
const LOCAL_PREFIX = projectFolder(`${home}/teammates/`)
export function localThread(folder: string) {
  if (!folder.startsWith(LOCAL_PREFIX)) return undefined
  const rest = folder.slice(LOCAL_PREFIX.length)
  const at = rest.indexOf('-threads-')
  if (at <= 0) return undefined
  return { teammateId: rest.slice(0, at), sessionId: rest.slice(at + '-threads-'.length) }
}

/** On a cloud computer: /home/<the teammate's user>/threads/<thread>. */
const CLOUD_FOLDER = /^-home-bt-([a-z0-9]+)-threads-(.+)$/
export function cloudThread(folder: string) {
  const match = CLOUD_FOLDER.exec(folder)
  return match ? { teammateId: match[1]!, sessionId: match[2]! } : undefined
}

/** The computer's own Claude and Codex logins, which a member's machine may run turns on. */
const machineConfigs = () => [
  { dir: process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), account: null },
  { dir: process.env.CODEX_HOME || join(homedir(), '.codex'), account: null },
]

/** A teammate's own logs on a cloud computer, read as its user. */
function teammateSource(user: string): LogSource {
  const prefix = projectFolder(`${teammateHome(user)}/threads/`)
  return {
    runAs: user,
    input: { configs: [], accountsDirs: [`${teammateHome(user)}/.accounts`], prefixes: [prefix] },
    threadOf: cloudThread,
  }
}

/** Every place on this computer where teammates' turns left logs. */
export async function logSources(): Promise<LogSource[]> {
  if (!CLOUD)
    return [
      {
        input: {
          configs: machineConfigs(),
          accountsDirs: [ACCOUNTS_DIR],
          prefixes: [LOCAL_PREFIX],
        },
        threadOf: localThread,
      },
    ]
  const users = (await readdir('/home').catch(() => [] as string[])).filter((u) =>
    /^bt-[a-z0-9]+$/.test(u),
  )
  return [
    ...users.map(teammateSource),
    // Turns ran on the runner's own account directories before each teammate had its own.
    {
      input: { configs: [], accountsDirs: [ACCOUNTS_DIR], prefixes: [projectFolder('/home/bt-')] },
      threadOf: cloudThread,
    },
  ]
}

/** Where a teammate's turns in a thread leave their logs: just that thread's project folder. */
export function threadSource(teammateId: string, sessionId: string, workDir: string): LogSource {
  const folder = projectFolder(
    CLOUD ? workDir : join(home, 'teammates', teammateId, 'threads', sessionId),
  )
  const thread = () => ({ sessionId, teammateId })
  if (CLOUD) {
    const source = teammateSource(teammateUser(teammateId))
    return { ...source, input: { ...source.input, folders: [folder] }, threadOf: thread }
  }
  return {
    input: {
      configs: machineConfigs(),
      accountsDirs: [ACCOUNTS_DIR],
      prefixes: [LOCAL_PREFIX],
      folders: [folder],
    },
    threadOf: thread,
  }
}

/** A scanned response as the API takes it; undefined when it is no thread's or does not fit. */
export function loggedResponse(
  r: ScannedResponse,
  thread: { sessionId: string; teammateId: string } | undefined,
): LoggedResponse | undefined {
  if (!thread) return undefined
  const parsed = LoggedResponse.safeParse({
    id: r.id,
    ...thread,
    ...(r.account ? { accountId: r.account } : {}),
    provider: r.provider,
    ...(r.model ? { model: r.model.slice(0, 200) } : {}),
    at: new Date(r.at).toISOString(),
    inputTokens: r.input,
    cacheReadTokens: r.cacheRead,
    cacheWriteTokens: r.cacheWrite,
    outputTokens: r.output,
    reasoningTokens: r.reasoning,
  })
  return parsed.success ? parsed.data : undefined
}

/** Run the scan, as the teammate's user on a cloud computer. */
function runScan(input: ScanInput, runAs?: string): Promise<ScanOutput> {
  const [command, args] = runAs
    ? ['sudo', ['-n', '-u', runAs, process.execPath, SCAN]]
    : [process.execPath, [SCAN]]
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: '/', stdio: ['pipe', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    let size = 0
    let err = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), SCAN_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > OUTPUT_MAX) child.kill('SIGKILL')
      else out.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => (err = (err + chunk.toString()).slice(-2000)))
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(err.trim() || `the scan exited with ${code}`))
      try {
        resolve(JSON.parse(Buffer.concat(out).toString('utf8')) as ScanOutput)
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(JSON.stringify(input))
  })
}

type Options = {
  /** Resolves once the API kept them; throws when it did not. */
  send: (responses: LoggedResponse[]) => Promise<void>
  stateFile: string
  /** Where the logs are; logSources by default. */
  sources?: () => Promise<LogSource[]>
  scan?: (input: ScanInput, runAs?: string) => Promise<ScanOutput>
}

export class UsageLogs {
  /** Where each log was read up to and its responses kept, by path. */
  private offsets: Record<string, LogMark> | undefined
  /** One scan at a time: two would read the same lines. */
  private queue: Promise<void> = Promise.resolve()
  private sweepTimer: NodeJS.Timeout | undefined
  private readonly afterTurn = new Map<string, NodeJS.Timeout>()

  constructor(private readonly options: Options) {}

  /** Look at every log now and then every few minutes. */
  start() {
    void this.sweep()
    this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_MS)
    this.sweepTimer.unref?.()
  }

  stop() {
    clearInterval(this.sweepTimer)
    for (const timer of this.afterTurn.values()) clearTimeout(timer)
    this.afterTurn.clear()
  }

  /** Every log on the computer, from where each was read up to. */
  sweep(): Promise<void> {
    return this.enqueue(async () => {
      for (const source of await (this.options.sources ?? logSources)()) await this.read(source)
    })
  }

  /** A teammate's stream ended in a thread: read its log once the harness wrote it all. */
  turnEnded(teammateId: string, sessionId: string, workDir: string) {
    const key = `${sessionId}-${teammateId}`
    clearTimeout(this.afterTurn.get(key))
    const timer = setTimeout(() => {
      this.afterTurn.delete(key)
      void this.readThread(teammateId, sessionId, workDir)
    }, AFTER_TURN_MS)
    timer.unref?.()
    this.afterTurn.set(key, timer)
  }

  readThread(teammateId: string, sessionId: string, workDir: string): Promise<void> {
    return this.enqueue(() => this.read(threadSource(teammateId, sessionId, workDir)))
  }

  private enqueue(work: () => Promise<void>) {
    const next = this.queue
      .then(work)
      .catch((error: unknown) =>
        console.warn(`usage logs: ${error instanceof Error ? error.message : String(error)}`),
      )
    this.queue = next
    return next
  }

  /** Read a source's logs on from where they were, until the API kept all of it. */
  private async read(source: LogSource) {
    const offsets = await this.loadOffsets()
    for (;;) {
      const output = await (this.options.scan ?? runScan)(
        { ...source.input, offsets, max: SCAN_MAX },
        source.runAs,
      )
      const responses = output.responses.flatMap((r) => {
        const logged = loggedResponse(r, source.threadOf(r.folder))
        return logged ? [logged] : []
      })
      for (let i = 0; i < responses.length; i += LOGGED_RESPONSES_MAX)
        await this.options.send(responses.slice(i, i + LOGGED_RESPONSES_MAX))
      Object.assign(offsets, output.offsets)
      if (Object.keys(output.offsets).length) await this.saveOffsets()
      if (!output.more) return
    }
  }

  private async loadOffsets() {
    if (!this.offsets) {
      try {
        const saved = JSON.parse(await readFile(this.options.stateFile, 'utf8')) as {
          offsets?: Record<string, LogMark>
        }
        this.offsets = saved.offsets ?? {}
      } catch {
        this.offsets = {}
      }
    }
    return this.offsets
  }

  private async saveOffsets() {
    const file = this.options.stateFile
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    const temp = `${file}.tmp`
    await writeFile(temp, JSON.stringify({ offsets: this.offsets }), { mode: 0o600 })
    await rename(temp, file)
  }
}
