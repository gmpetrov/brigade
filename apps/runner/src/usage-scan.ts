// Read what a harness's own session logs say each model response spent, from where they were
// last read up to. Run as its own process so it reads the logs with the teammate's rights:
//   node usage-scan.js < '<json: ScanInput>'
// Prints a ScanOutput as JSON. Reads only what each response spent, never what was said.
//
// Claude Code writes a transcript per session in its config directory, under
// projects/<its working directory, each character not a letter or digit made "-">/, as JSON
// lines: <session>.jsonl, and <session>/subagents/*.jsonl for its subagents. A response is a
// line of type "assistant" per content block, each with the response's id and usage: the input
// is the same in each, the output grows to its final count in the last.
//
// Codex writes a rollout per thread, its subagents' included, under sessions/YYYY/MM/DD/ in its
// home: JSON lines, the first its session_meta (with the working directory), a turn_context
// (with the model) per turn, and a token_usage_record per model request with the response's id
// and usage. Its token_count events are no use: a compaction repeats one, and a fork's totals
// start from its parent's.
import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

export type Provider = 'claude_code' | 'codex'

/** Where a log was read up to, and what was learned before that point that later lines need. */
export type LogMark = {
  at: number
  /** A Codex rollout's working directory, from its first line. */
  cwd?: string
  /** The model of a Codex rollout's latest turn. */
  model?: string
}

export type ScanInput = {
  /** Config directories: an account's, named by its id, or the computer's own login (null). */
  configs: { dir: string; account: string | null }[]
  /** Directories of one config directory per account, each named by the account's id. */
  accountsDirs: string[]
  /**
   * The working directories to read the logs of, as Claude Code names a project folder after
   * one: those whose name starts with one of these.
   */
  prefixes: string[]
  /** Only these project folders, when set. */
  folders?: string[]
  /** Where each log was read up to, by its path. */
  offsets: Record<string, LogMark>
  /** Stop after about this many responses: the next call reads on from there. */
  max: number
}

export type ScannedResponse = {
  provider: Provider
  /** The account whose config directory it is in; null for the computer's own login. */
  account: string | null
  /** Its working directory, as Claude Code names a project folder after it. */
  folder: string
  id: string
  model?: string
  at: string
  /** All input, the cache's reads and writes included. */
  input: number
  cacheRead: number
  cacheWrite: number
  /** Reasoning included. */
  output: number
  reasoning: number
}

export type ScanOutput = {
  responses: ScannedResponse[]
  /** Where each log read is read up to now: the end of its last whole line. */
  offsets: Record<string, LogMark>
  /** Stopped at `max`: there is more to read. */
  more: boolean
}

/** Claude Code's project folder for a working directory. */
export const projectFolder = (workDir: string) => workDir.replace(/[^a-zA-Z0-9]/g, '-')

const count = (n: unknown) =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : 0

const timestamp = (at: unknown) =>
  typeof at === 'string' && !Number.isNaN(Date.parse(at)) ? at : undefined

function parse(line: string): Record<string, any> | undefined {
  try {
    const value: unknown = JSON.parse(line)
    return value && typeof value === 'object' ? (value as Record<string, any>) : undefined
  } catch {
    return undefined
  }
}

type Response = Omit<ScannedResponse, 'provider' | 'account' | 'folder'>

/** A Claude Code transcript line's response, if it is one that spent tokens. */
export function claudeResponse(line: string): Response | undefined {
  // Most lines are tool results and messages: only a response's are parsed.
  if (!line.includes('"assistant"') || !line.includes('"usage"')) return undefined
  const entry = parse(line)
  const message = entry?.message
  const usage = message?.usage
  if (entry?.type !== 'assistant' || !usage || typeof message.id !== 'string') return undefined
  // An error Claude Code wrote itself: no request behind it.
  if (message.model === '<synthetic>') return undefined
  const at = timestamp(entry.timestamp)
  if (!at) return undefined
  const cacheRead = count(usage.cache_read_input_tokens)
  const cacheWrite = count(usage.cache_creation_input_tokens)
  return {
    id: message.id,
    ...(typeof message.model === 'string' && message.model ? { model: message.model } : {}),
    at,
    input: count(usage.input_tokens) + cacheRead + cacheWrite,
    cacheRead,
    cacheWrite,
    output: count(usage.output_tokens),
    reasoning: count(usage.output_tokens_details?.thinking_tokens),
  }
}

/** A Codex rollout line: its working directory, a turn's model, or a request's usage. */
export function codexLine(
  line: string,
): { cwd: string } | { model: string } | { response: Response } | undefined {
  const kind = /^\{[^{]*"type":"(session_meta|turn_context|token_usage_record)"/.exec(line)?.[1]
  if (!kind) return undefined
  const entry = parse(line)
  const payload = entry?.payload
  if (!payload || entry.type !== kind) return undefined
  if (kind === 'session_meta')
    return typeof payload.cwd === 'string' ? { cwd: payload.cwd } : undefined
  if (kind === 'turn_context')
    return typeof payload.model === 'string' && payload.model ? { model: payload.model } : undefined
  const usage = payload.usage
  const at = timestamp(entry.timestamp)
  if (!usage || !at || typeof payload.response_id !== 'string' || !payload.response_id)
    return undefined
  return {
    response: {
      // A response's id is the provider's; its thread's makes it the request's own.
      id: `${typeof payload.thread_id === 'string' ? payload.thread_id : ''}:${payload.response_id}`,
      at,
      // Codex counts the cache's reads and writes in its input, and reasoning in its output.
      input: count(usage.input_tokens),
      cacheRead: count(usage.cached_input_tokens),
      cacheWrite: count(usage.cache_write_input_tokens),
      output: count(usage.output_tokens),
      reasoning: count(usage.reasoning_output_tokens),
    },
  }
}

/** The .jsonl files under a directory, `depth` levels down at most. */
async function logsUnder(root: string, depth: number, skip?: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (dir: string, left: number) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(join(dir, entry.name))
      else if (entry.isDirectory() && left > 0 && entry.name !== skip)
        await walk(join(dir, entry.name), left - 1)
    }
  }
  await walk(root, depth)
  return found.sort()
}

/**
 * Read a log from `offset` to its last whole line, giving each line to `take`. Stops early when
 * `take` says so. Returns where it stopped: past the last line read.
 */
async function readLines(file: string, offset: number, take: (line: string) => boolean) {
  let position = offset
  let rest: Buffer[] = []
  let stopped = false
  const stream = createReadStream(file, { start: offset })
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      let start = 0
      for (;;) {
        const end = chunk.indexOf(0x0a, start)
        if (end === -1) break
        const piece = chunk.subarray(start, end)
        const line = rest.length ? Buffer.concat([...rest, piece]) : piece
        rest = []
        position += line.length + 1
        start = end + 1
        if (!take(line.toString('utf8'))) {
          stopped = true
          break
        }
      }
      if (stopped) break
      if (start < chunk.length) rest.push(chunk.subarray(start))
    }
  } finally {
    stream.destroy()
  }
  return position
}

/**
 * A Codex rollout's working directory, from its first line: null when that line names none,
 * undefined while it is still being written.
 */
async function firstCwd(file: string) {
  let cwd: string | null = null
  const read = await readLines(file, 0, (line) => {
    const meta = codexLine(line)
    if (meta && 'cwd' in meta) cwd = meta.cwd
    return false
  })
  return read > 0 ? cwd : undefined
}

export async function scan(input: ScanInput): Promise<ScanOutput> {
  const configs = [...input.configs]
  for (const dir of input.accountsDirs) {
    const accounts = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const a of accounts)
      if (a.isDirectory()) configs.push({ dir: join(dir, a.name), account: a.name })
  }
  // A thread's working directory, for good; and one this scan reads (a turn's own, or all).
  const thread = (folder: string) => input.prefixes.some((p) => folder.startsWith(p))
  const wanted = (folder: string) =>
    thread(folder) && (!input.folders || input.folders.includes(folder))
  const offsets: Record<string, LogMark> = {}
  const byId = new Map<string, ScannedResponse>()
  const full = () => byId.size >= input.max
  const add = (r: ScannedResponse) => {
    const seen = byId.get(r.id)
    if (!seen) return void byId.set(r.id, r)
    seen.output = Math.max(seen.output, r.output)
    seen.reasoning = Math.max(seen.reasoning, r.reasoning)
  }
  /** Where to read a log from, and what is known of it: nothing new when it did not grow. */
  const from = async (file: string) => {
    const size = await stat(file).then(
      (s) => s.size,
      () => -1,
    )
    const mark = input.offsets[file]
    if (size < 0 || (mark && mark.at === size)) return undefined
    // A log shorter than where it was read up to was written anew: read it all again.
    return mark && mark.at <= size ? { ...mark, size } : { at: 0, size }
  }

  for (const config of configs) {
    // Claude Code's transcripts, by working directory.
    const projects = join(config.dir, 'projects')
    const folders = (await readdir(projects).catch(() => [] as string[])).filter(wanted)
    for (const folder of folders) {
      for (const file of await logsUnder(join(projects, folder), 2, 'memory')) {
        if (full()) return { responses: [...byId.values()], offsets, more: true }
        const start = await from(file)
        if (!start) continue
        offsets[file] = {
          at: await readLines(file, start.at, (line) => {
            const r = claudeResponse(line)
            if (r) add({ provider: 'claude_code', account: config.account, folder, ...r })
            return !full()
          }),
        }
      }
    }
    // Codex's rollouts, each naming its working directory first.
    for (const file of await logsUnder(join(config.dir, 'sessions'), 3)) {
      if (full()) return { responses: [...byId.values()], offsets, more: true }
      const start = await from(file)
      if (!start) continue
      const cwd = start.cwd ?? (start.at === 0 ? await firstCwd(file) : null)
      // Its first line still being written: read once it is whole.
      if (cwd === undefined) continue
      // A rollout of no thread's (a memory run's, a member's own): never read past its first line.
      if (cwd === null || !thread(projectFolder(cwd))) {
        offsets[file] = { at: start.size, ...(cwd === null ? {} : { cwd }) }
        continue
      }
      // Another thread's, when this scan reads one: left where it was, for its own or the next sweep.
      if (!wanted(projectFolder(cwd))) continue
      const folder = projectFolder(cwd)
      let model = start.model
      const at = await readLines(file, start.at, (line) => {
        const read = codexLine(line)
        if (!read || 'cwd' in read) return true
        if ('model' in read) model = read.model
        else
          add({
            provider: 'codex',
            account: config.account,
            folder,
            ...read.response,
            ...(model ? { model } : {}),
          })
        return !full()
      })
      offsets[file] = { at, cwd, ...(model ? { model } : {}) }
    }
  }
  return { responses: [...byId.values()], offsets, more: false }
}

async function main() {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  const output = await scan(JSON.parse(Buffer.concat(chunks).toString('utf8')) as ScanInput)
  process.stdout.write(JSON.stringify(output))
}

// Run as a script, not when a test imports it.
if (process.argv[1] && /usage-scan\.[jt]s$/.test(process.argv[1])) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
