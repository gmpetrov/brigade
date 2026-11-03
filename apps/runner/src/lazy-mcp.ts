// An MCP server on stdio started when the harness first needs it, rather than when its turn
// starts: the browser's (Playwright's, about 130 MB) is started at the thread's first browser
// tool call, so a turn that does not browse does not hold it. Until then this answers the
// harness's handshake and tool list itself, as the server answered that same handshake last
// time (kept in a file), then starts the server, gives it the harness's handshake and passes
// everything through. A handshake it has no answers for goes to the server, started at once,
// and the server's answers are kept for the next turns. Claude Code opens with a probe of a
// later protocol (server/discover) before its handshake: a server that refuses it gets the
// handshake next, so the refusal is kept with it and the probe is not given to a server
// started late.
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
import { isDeepStrictEqual } from 'node:util'

type Rpc = {
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { message?: string }
}

/**
 * The server's answers to a harness's opening, and what the harness sent: its probe (refused),
 * its handshake, the tool list before any call.
 */
type Handshake = {
  probe?: { params: unknown; error: Record<string, unknown> }
  initialize: { params: unknown; result: Record<string, unknown> }
  tools: { tools: unknown[] }
}

/** Claude Code's probe of a later protocol, before its handshake. */
const PROBE = 'server/discover'

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
    if (!('params' in kept.initialize) || !isObject(kept.initialize.result)) return undefined
    if (!Array.isArray(kept.tools.tools)) return undefined
    if (kept.probe !== undefined && (!isObject(kept.probe) || !isObject(kept.probe.error)))
      return undefined
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
  /** What the server's answers depend on besides the harness's handshake: its program, its settings. */
  identity: unknown
  /**
   * Where the answers are kept: a folder only this user can write to (they become tool
   * descriptions). Without one, nothing is kept or answered here: the server starts at once.
   */
  dir: string | undefined
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
  /** The harness's probe, answered here from what was kept. */
  let probe: Rpc | undefined
  let initialize: Rpc | undefined
  let initialized: string | undefined
  let known: Handshake | undefined
  let file: string | undefined
  let ended = false
  /** The server's answers to the harness's opening, being kept (an opening not seen before). */
  let keeping:
    | {
        probeId?: Rpc['id']
        probe?: Handshake['probe']
        initializeId?: Rpc['id']
        initialize?: Handshake['initialize']
        listId?: Rpc['id']
        tools?: Handshake['tools']
      }
    | undefined
  /** What the harness opened with, as the server will be asked it. */
  const asked = (message: Rpc) => message.params ?? null

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
      if (message?.id != null && message.id === keeping.probeId) {
        // A server that takes the probe may skip the handshake: its opening is not kept.
        if (isObject(message.error) && keeping.probe) {
          keeping.probe = { params: keeping.probe.params, error: message.error }
          keeping.probeId = undefined
        } else keeping = undefined
      } else if (message?.id != null && message.id === keeping.initializeId) {
        if (isObject(message.result) && keeping.initialize) {
          keeping.initialize = { params: keeping.initialize.params, result: message.result }
          keeping.initializeId = undefined
        } else keeping = undefined
      } else if (message?.id != null && message.id === keeping.listId && isObject(message.result))
        keeping.tools = message.result as Handshake['tools']
      const answered =
        keeping &&
        keeping.probeId === undefined &&
        keeping.initializeId === undefined &&
        keeping.initialize &&
        keeping.tools &&
        Array.isArray(keeping.tools.tools)
      if (keeping && answered) {
        keepHandshake(options.dir!, file!, {
          ...(keeping.probe ? { probe: keeping.probe } : {}),
          initialize: keeping.initialize!,
          tools: keeping.tools!,
        })
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
        else if (message?.method === 'initialize' && message.id != null && !keeping.initialize) {
          keeping.initializeId = message.id
          keeping.initialize = { params: asked(message), result: {} }
        } else if (message?.method === 'tools/list' && message.id != null && keeping.listId == null)
          keeping.listId = message.params?.cursor === undefined ? message.id : undefined
      }
      return toServer(line)
    }
    if (server) return void waiting.push(line)
    const message = parse(line)
    if (!initialize) {
      const opening =
        options.dir !== undefined &&
        message?.id != null &&
        (message.method === 'initialize' || (message.method === PROBE && !probe))
      if (opening) {
        // The opening's first request names its file.
        if (!file) {
          file = join(
            options.dir!,
            `${createHash('sha256')
              .update(JSON.stringify([options.identity, message.method, asked(message)]))
              .digest('hex')
              .slice(0, 32)}.json`,
          )
          known = readHandshake(file)
        }
        if (message.method === PROBE) {
          probe = message
          if (known?.probe && isDeepStrictEqual(known.probe.params, asked(message)))
            return toHarness({ id: message.id, error: known.probe.error })
          // Not the probe kept: the server answers it, and what follows.
          keeping = { probeId: message.id, probe: { params: asked(message), error: {} } }
        } else {
          initialize = message
          const same =
            known !== undefined &&
            isDeepStrictEqual(known.initialize.params, asked(message)) &&
            (probe
              ? known.probe !== undefined && isDeepStrictEqual(known.probe.params, asked(probe))
              : known.probe === undefined)
          if (same) {
            try {
              utimesSync(file, new Date(), new Date())
            } catch {}
            return toHarness({ id: message.id, result: known!.initialize.result })
          }
          // A probe answered from the file stays as it was; the handshake is the server's.
          keeping = {
            ...(probe && known?.probe ? { probe: known.probe } : {}),
            initializeId: message.id,
            initialize: { params: asked(message), result: {} },
          }
        }
      }
      // An opening with no answers kept: the server answers it, started now.
      start(false)
      return toServer(line)
    }
    // A known opening: answered here until the server is needed.
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
