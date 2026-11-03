// An MCP server on stdio started when the harness first needs it, rather than when its turn
// starts: the browser's (Playwright's, about 130 MB) is started at the thread's first browser
// tool call, so a turn that does not browse does not hold it. Until then this answers the
// harness's handshake and tool list itself, as the server answered that same handshake last
// time (kept in a file), then starts the server, gives it the harness's handshake and passes
// everything through. A handshake it has no answers for goes to the server, started at once,
// and the server's answers are kept for the next turns.
//
// Only for a server whose handshake and tool list depend on nothing but its program, its
// arguments and the harness's handshake, and that lists the same tools until a tool is called
// (Playwright's adds a page's own tools after a call: those are listed by the server itself).
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

type Rpc = {
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { message?: string }
}

type Handshake = { initialize: Record<string, unknown>; tools: { tools: unknown[] } }

/** Kept answers no turn used for this long are removed. */
export const HANDSHAKE_KEEP_MS = 30 * 24 * 60 * 60_000
/** The id of the handshake given to a server started late (the harness's own ids are numbers). */
const RELAY_INITIALIZE = 'brigade-relay-initialize'

const isObject = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === 'object' && !Array.isArray(value)

function parse(line: string): Rpc | undefined {
  try {
    const message = JSON.parse(line) as unknown
    return isObject(message) ? (message as Rpc) : undefined
  } catch {
    return undefined
  }
}

/** A stream's newline-delimited messages (MCP's stdio framing), without rescanning long ones. */
function onLines(stream: NodeJS.ReadableStream, onLine: (line: string) => void, onEnd: () => void) {
  let pending: string[] = []
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    let start = 0
    for (let end = chunk.indexOf('\n'); end >= 0; end = chunk.indexOf('\n', start)) {
      pending.push(chunk.slice(start, end))
      const line = pending.join('')
      pending = []
      start = end + 1
      if (line.trim()) onLine(line)
    }
    if (start < chunk.length) pending.push(chunk.slice(start))
  })
  stream.on('end', () => {
    const line = pending.join('')
    if (line.trim()) onLine(line)
    onEnd()
  })
}

function readHandshake(file: string): Handshake | undefined {
  try {
    const kept = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (!isObject(kept) || !isObject(kept.initialize) || !isObject(kept.tools)) return undefined
    if (!Array.isArray(kept.tools.tools)) return undefined
    return kept as Handshake
  } catch {
    return undefined
  }
}

function keepHandshake(dir: string, file: string, handshake: Handshake) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const partial = `${file}.${process.pid}.tmp`
    writeFileSync(partial, JSON.stringify(handshake), { mode: 0o600 })
    renameSync(partial, file)
    for (const name of readdirSync(dir)) {
      const other = join(dir, name)
      if (Date.now() - statSync(other).mtimeMs > HANDSHAKE_KEEP_MS) rmSync(other, { force: true })
    }
  } catch {}
}

export function serveMcpLazily(options: {
  command: string
  args: string[]
  /** What the server's answers depend on besides the harness's handshake: its program, its arguments. */
  identity: unknown
  /** Where the answers are kept: a folder only this user can write to (they become tool descriptions). */
  dir: string
  /** The server exited, or the harness left before it was needed. */
  onExit: (code: number) => void
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
}) {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const toHarness = (message: Rpc) =>
    output.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')

  let server: ChildProcess | undefined
  /** The server has the harness's handshake: everything passes through. */
  let ready = false
  /** The harness's messages for the server, while it starts. */
  const waiting: string[] = []
  let initialize: Rpc | undefined
  let initialized: string | undefined
  let known: Handshake | undefined
  let file: string | undefined
  let ended = false
  /** The server's answers to the harness's handshake, being kept (a handshake not seen before). */
  let keeping:
    | { initialize?: Record<string, unknown>; tools?: Handshake['tools']; listId?: Rpc['id'] }
    | undefined

  const toServer = (line: string) => {
    if (!ended) server!.stdin!.write(line + '\n')
  }

  function start(late: boolean) {
    const child = spawn(options.command, options.args, { stdio: ['pipe', 'pipe', 'inherit'] })
    server = child
    // Writing to a server that just exited: its exit says it.
    child.stdin!.on('error', () => undefined)
    child.on('error', () => options.onExit(1))
    // Once its output is all passed on.
    child.on('close', (code, signal) => options.onExit(code ?? (signal ? 1 : 0)))
    onLines(child.stdout!, fromServer, () => undefined)
    if (late) {
      // The harness's own handshake, again, for the server: its answer goes no further.
      toServer(JSON.stringify({ ...initialize, id: RELAY_INITIALIZE }))
    } else ready = true
  }

  function fromServer(line: string) {
    if (!ready) {
      const message = parse(line)
      if (message?.id === RELAY_INITIALIZE) {
        if (message.error) {
          const why = `The browser's tools did not start: ${message.error.message ?? 'no reason given'}`
          for (const waited of waiting.splice(0)) {
            const request = parse(waited)
            if (request?.id != null && request.method)
              toHarness({ id: request.id, error: { message: why } })
          }
          server!.kill()
          return
        }
        ready = true
        toServer(
          initialized ?? JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        )
        for (const waited of waiting.splice(0)) toServer(waited)
        return
      }
    }
    if (keeping) {
      const message = parse(line)
      if (message?.id != null && message.id === initialize?.id && isObject(message.result))
        keeping.initialize = message.result
      if (message?.id != null && message.id === keeping.listId && isObject(message.result))
        keeping.tools = message.result as Handshake['tools']
      if (keeping.initialize && keeping.tools && Array.isArray(keeping.tools.tools)) {
        keepHandshake(options.dir, file!, { initialize: keeping.initialize, tools: keeping.tools })
        keeping = undefined
      }
    }
    output.write(line + '\n')
  }

  function fromHarness(line: string) {
    if (ready) {
      if (keeping) {
        const message = parse(line)
        // The tools listed before any call: a call can add a page's own tools to the list.
        if (message?.method === 'tools/call') keeping = undefined
        else if (message?.method === 'tools/list' && message.id != null && keeping.listId == null)
          keeping.listId = message.params?.cursor === undefined ? message.id : undefined
      }
      return toServer(line)
    }
    if (server) return void waiting.push(line)
    const message = parse(line)
    if (!initialize) {
      if (message?.method === 'initialize' && message.id != null) {
        initialize = message
        file = join(
          options.dir,
          `${createHash('sha256')
            .update(JSON.stringify([options.identity, message.params ?? null]))
            .digest('hex')
            .slice(0, 32)}.json`,
        )
        known = readHandshake(file)
        if (known) {
          try {
            utimesSync(file, new Date(), new Date())
          } catch {}
          return toHarness({ id: message.id, result: known.initialize })
        }
        keeping = {}
      }
      // A handshake with no answers kept: the server answers it, started now.
      start(false)
      return toServer(line)
    }
    // A known handshake: answered here until the server is needed.
    if (message?.method === 'notifications/initialized') return void (initialized = line)
    if (message?.id != null && message.method === 'ping')
      return toHarness({ id: message.id, result: {} })
    if (
      message?.id != null &&
      message.method === 'tools/list' &&
      message.params?.cursor === undefined
    )
      return toHarness({ id: message.id, result: known!.tools })
    // Nothing to tell a server that has not started (a cancelled request was answered here).
    if (message && message.id == null && message.method?.startsWith('notifications/')) return
    waiting.push(line)
    start(true)
  }

  onLines(input, fromHarness, () => {
    ended = true
    if (server) server.stdin!.end()
    else options.onExit(0)
  })

  return {
    /** Stop the server with this signal, or leave when there is none. */
    stop(signal: NodeJS.Signals) {
      if (server) server.kill(signal)
      else options.onExit(0)
    },
  }
}
