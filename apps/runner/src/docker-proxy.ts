// A teammate's Docker, seen from each of its threads, on a cloud computer.
//
// Each teammate runs one rootless Docker on the computer's network (one daemon,
// one copy of its images), started by this proxy on first use. Each thread's
// DOCKER_HOST is a socket of this proxy's (/run/brigade-docker/<thread>/<user>/
// docker.sock), which relays to that Docker as is, with two changes:
//
// - A container created there is labelled with the thread, and what it
//   publishes goes on the thread's own loopback address (127.231.x.y, written
//   by the root thread helper beside the socket) instead of 0.0.0.0. Two
//   threads can then both publish 5432: rootless Docker publishes a port number
//   once per loopback address, but once for all others (it reaches its
//   containers through its own 127.0.0.1 for those).
// - When one of the thread's containers starts, its client hears it only once
//   the root helper (`docker-ports`, through sudo) has made those ports the
//   thread's: localhost:5432 in the thread's network reaches 127.231.x.y:5432
//   on the host, and no other thread does. Docker's events do the same when a
//   container starts or stops by itself.
//
// Everything else passes untouched, connections Docker takes over (attach,
// exec, BuildKit's session) included. Only the requests on a connection are
// read, never the responses, which are relayed as they come.
import { execFile } from 'node:child_process'
import { chmodSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { request } from 'node:http'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const THREAD_LABEL = 'brigade.thread'
const THREAD = /^[A-Za-z0-9_-]{1,64}$/
const LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/
const CREATE = /^(?:\/v[\d.]+)?\/containers\/create(?:\?|$)/
const STARTS = /^(?:\/v[\d.]+)?\/containers\/[^/?]+\/(?:start|restart)(?:\?|$)/
/** A request head longer than this is not Docker's: the rest of the connection passes as is. */
const MAX_HEAD = 64 * 1024

type Binding = { HostIp?: string; HostPort?: string }
export type ContainerCreate = {
  Image?: string
  Labels?: Record<string, string> | null
  ExposedPorts?: Record<string, object> | null
  HostConfig?: {
    PortBindings?: Record<string, Binding[] | null> | null
    PublishAllPorts?: boolean
    NetworkMode?: string
  } | null
}

/** Whether a create publishes every port its image exposes (`-P`): those are read from the image. */
export const publishesAll = (body: ContainerCreate) =>
  Boolean(body.HostConfig?.PublishAllPorts) && !sharesNetwork(body)

const sharesNetwork = (body: ContainerCreate) => {
  const mode = body.HostConfig?.NetworkMode ?? ''
  return mode === 'host' || mode.startsWith('container:')
}

/**
 * A container create, for the thread: labelled with it, each published port on
 * the thread's address, the same host port (or a free one, when none was
 * asked). With `-P`, the ports its image exposes (`imagePorts`) too, as Docker
 * would publish them. A container on another's network or the host's publishes
 * nothing.
 */
export function rewriteCreate(
  body: ContainerCreate,
  thread: string,
  address: string,
  imagePorts: string[] = [],
): ContainerCreate {
  const labeled = { ...body, Labels: { ...(body.Labels ?? {}), [THREAD_LABEL]: thread } }
  const host = body.HostConfig
  if (!host || sharesNetwork(body)) return labeled
  const bindings: Record<string, Binding[]> = {}
  for (const [port, list] of Object.entries(host.PortBindings ?? {})) {
    // 127.0.0.1:5432 and [::1]:5432 are one port on the thread's address.
    const ports = [...new Set((list?.length ? list : [{}]).map((b) => b.HostPort ?? ''))]
    bindings[port] = ports.map((HostPort) => ({ HostIp: address, HostPort }))
  }
  if (host.PublishAllPorts)
    for (const port of [...Object.keys(body.ExposedPorts ?? {}), ...imagePorts])
      bindings[port] ??= [{ HostIp: address, HostPort: '' }]
  return { ...labeled, HostConfig: { ...host, PortBindings: bindings, PublishAllPorts: false } }
}

type Head = { line: string; headers: [string, string][]; method: string; path: string }

function parseHead(raw: string): Head {
  const [line = '', ...rest] = raw.split('\r\n')
  const headers = rest.filter(Boolean).map((h): [string, string] => {
    const at = h.indexOf(':')
    return at < 0 ? [h, ''] : [h.slice(0, at).trim(), h.slice(at + 1).trim()]
  })
  const [method = '', path = ''] = line.split(' ')
  return { line, headers, method, path }
}

const header = (head: Head, name: string) =>
  head.headers.find(([key]) => key.toLowerCase() === name)?.[1]

/** A chunked body, decoded, and how many bytes it took; null while it is not all there. */
export function dechunk(buf: Buffer): { body: Buffer; used: number } | null {
  const parts: Buffer[] = []
  let at = 0
  for (;;) {
    const eol = buf.indexOf('\r\n', at)
    if (eol < 0) return null
    const size = Number.parseInt(buf.toString('latin1', at, eol).split(';')[0]!.trim(), 16)
    if (!Number.isFinite(size) || size < 0) throw new Error('bad chunk')
    at = eol + 2
    if (size === 0) {
      // Trailers, if any, up to an empty line.
      for (;;) {
        const end = buf.indexOf('\r\n', at)
        if (end < 0) return null
        const empty = end === at
        at = end + 2
        if (empty) return { body: Buffer.concat(parts), used: at }
      }
    }
    if (buf.length < at + size + 2) return null
    parts.push(buf.subarray(at, at + size))
    at += size + 2
  }
}

export type Hooks = {
  /** A container create's body, as it goes to Docker. */
  create(body: Buffer): Promise<Buffer>
  /** A container of the thread started: resolves once its ports are the thread's. */
  started(): Promise<void>
}

type State =
  | { kind: 'head' }
  | { kind: 'length'; left: number; then: 'head' | 'raw' }
  | {
      kind: 'chunked'
      phase: 'size' | 'data' | 'crlf' | 'trailer'
      left: number
      then: 'head' | 'raw'
    }
  | { kind: 'raw' }

/**
 * Relay one client connection to Docker's: its requests read one by one (a
 * create rewritten, a start's answer held until its ports are up), until
 * Docker takes the connection over; then, and for all responses, bytes as they
 * come. When Docker closes, the client's side closes whole, as Docker's would:
 * a client whose stdin stays open (`docker compose exec`) still ends.
 */
export function relay(client: Socket, upstream: Socket, hooks: Hooks) {
  let buf = Buffer.alloc(0)
  let state: State = { kind: 'head' }
  let busy = false
  let clientEnded = false
  let hold = false
  let held = Buffer.alloc(0)
  // A held answer, until it is written: Docker may close meanwhile.
  let flushed = Promise.resolve()

  const send = (data: Buffer | string) => {
    if (!upstream.write(data)) {
      client.pause()
      upstream.once('drain', () => client.resume())
    }
  }
  const after = (then: 'head' | 'raw'): State =>
    then === 'raw' ? { kind: 'raw' } : { kind: 'head' }
  const raw = () => {
    state = { kind: 'raw' }
    if (buf.length) send(buf)
    buf = Buffer.alloc(0)
  }

  async function pump() {
    if (busy) return
    busy = true
    try {
      while (buf.length > 0 && state.kind !== 'raw') {
        if (state.kind === 'head') {
          const end = buf.indexOf('\r\n\r\n')
          if (end < 0) {
            if (buf.length > MAX_HEAD) raw()
            break
          }
          const rawHead = buf.subarray(0, end + 4)
          const head = parseHead(rawHead.toString('latin1', 0, end))
          const length = Number(header(head, 'content-length') ?? 0)
          const chunked = /chunked/i.test(header(head, 'transfer-encoding') ?? '')
          // Docker takes the connection over: attach, exec, BuildKit's session.
          const then = header(head, 'upgrade') ? 'raw' : 'head'
          if (head.method === 'POST' && CREATE.test(head.path)) {
            const body = chunked
              ? dechunk(buf.subarray(end + 4))
              : buf.length >= end + 4 + length
                ? { body: buf.subarray(end + 4, end + 4 + length), used: length }
                : null
            if (!body) break
            buf = buf.subarray(end + 4 + body.used)
            const rewritten = await hooks.create(body.body).catch(() => body.body)
            const kept = head.headers.filter(
              ([key]) => !/^(content-length|transfer-encoding)$/i.test(key),
            )
            send(
              [
                head.line,
                ...kept.map(([k, v]) => `${k}: ${v}`),
                `Content-Length: ${rewritten.length}`,
                '',
                '',
              ].join('\r\n'),
            )
            send(rewritten)
            state = after(then)
            continue
          }
          if (head.method === 'POST' && STARTS.test(head.path)) hold = true
          buf = buf.subarray(end + 4)
          send(rawHead)
          state = chunked
            ? { kind: 'chunked', phase: 'size', left: 0, then }
            : length > 0
              ? { kind: 'length', left: length, then }
              : after(then)
          if (state.kind === 'raw') raw()
          continue
        }
        if (state.kind === 'length') {
          const part = buf.subarray(0, state.left)
          buf = buf.subarray(part.length)
          send(part)
          state.left -= part.length
          if (state.left === 0) state = after(state.then)
          if (state.kind === 'raw') raw()
          continue
        }
        // Chunked: passed as it comes, read only to know where it ends.
        if (state.phase === 'data' || state.phase === 'crlf') {
          const part = buf.subarray(0, state.left)
          buf = buf.subarray(part.length)
          send(part)
          state.left -= part.length
          if (state.left === 0)
            state =
              state.phase === 'data'
                ? { ...state, phase: 'crlf', left: 2 }
                : { ...state, phase: 'size' }
          continue
        }
        const eol = buf.indexOf('\r\n')
        if (eol < 0) break
        const line = buf.subarray(0, eol + 2)
        buf = buf.subarray(eol + 2)
        send(line)
        if (state.phase === 'trailer') {
          if (eol === 0) state = after(state.then)
        } else {
          const size = Number.parseInt(line.toString('latin1').split(';')[0]!.trim(), 16)
          state =
            size > 0 ? { ...state, phase: 'data', left: size } : { ...state, phase: 'trailer' }
        }
        if (state.kind === 'raw') raw()
      }
    } catch {
      // Not HTTP as Docker speaks it: as is from here.
      raw()
    } finally {
      busy = false
    }
    if (clientEnded) upstream.end()
    else if (buf.length > 0 && state.kind === 'raw') raw()
  }

  client.on('data', (chunk: Buffer) => {
    if (state.kind === 'raw' && !busy) return send(chunk)
    buf = Buffer.concat([buf, chunk])
    void pump()
  })
  client.on('end', () => {
    clientEnded = true
    if (!busy) upstream.end()
  })
  upstream.on('data', (chunk: Buffer) => {
    if (!hold) {
      if (!client.write(chunk)) {
        upstream.pause()
        client.once('drain', () => upstream.resume())
      }
      return
    }
    // A start's answer: once its head is here, and the start went through, its ports first.
    held = Buffer.concat([held, chunk])
    if (held.indexOf('\r\n\r\n') < 0) return
    hold = false
    const out = held
    held = Buffer.alloc(0)
    upstream.pause()
    const ok = /^HTTP\/1\.[01] 2\d\d/.test(out.toString('latin1', 0, 16))
    flushed = (ok ? hooks.started().catch(() => undefined) : Promise.resolve()).then(() => {
      client.write(out)
      upstream.resume()
    })
  })
  upstream.on('end', () => {
    void flushed.then(() => {
      if (held.length) client.write(held)
      client.end(() => client.destroy())
    })
  })
  client.on('close', () => upstream.destroy())
  upstream.on('close', () => {
    if (!client.writableEnded) client.destroy()
  })
  client.on('error', () => upstream.destroy())
  upstream.on('error', () => client.destroy())
  // Gone while Docker was starting.
  if (client.destroyed) upstream.destroy()
  else client.resume()
}

export type ProxyOptions = {
  /** The teammate's user, whose folder each thread's socket is in. */
  user: string
  /** Where the thread helper makes threads' folders (/run/brigade-docker). */
  root: string
  /** The teammate's Docker. */
  upstream: string
  /** Start that Docker; resolves once asked (the proxy waits for its socket). */
  startDocker(): Promise<void>
  /** Make the thread's published ports its own (the thread helper's docker-ports). */
  publish(thread: string): Promise<void>
  /** No thread left: the proxy has nothing to do. */
  onEmpty?(): void
  /** How long to wait for Docker to answer once started. */
  startTimeoutMs?: number
}

/** The proxy for all of a teammate's threads: one socket per thread folder. */
export class DockerProxy {
  private servers = new Map<string, { server: Server; address: string }>()
  private starting: Promise<void> | null = null
  private watching = false
  private events: ReturnType<typeof request> | null = null
  private publishing = new Map<string, { run: Promise<void>; again: Promise<void> | null }>()
  private timers = new Map<string, NodeJS.Timeout>()

  constructor(private options: ProxyOptions) {}

  /** The threads it serves, by their folders: each with a socket, those gone closed. */
  scan() {
    const { root, user } = this.options
    const seen = new Set<string>()
    let threads: string[] = []
    try {
      threads = readdirSync(root)
    } catch {
      // None yet.
    }
    for (const thread of threads) {
      if (!THREAD.test(thread)) continue
      const dir = join(root, thread, user)
      let address: string
      try {
        address = readFileSync(join(dir, 'address'), 'utf8').trim()
      } catch {
        continue
      }
      if (!LOOPBACK.test(address)) continue
      seen.add(thread)
      const current = this.servers.get(thread)
      if (current?.address === address) continue
      current?.server.close()
      this.servers.set(thread, { server: this.listen(thread, dir, address), address })
    }
    for (const [thread, { server }] of this.servers)
      if (!seen.has(thread)) {
        server.close()
        this.servers.delete(thread)
      }
    if (this.servers.size === 0) this.options.onEmpty?.()
  }

  threads() {
    return [...this.servers.keys()]
  }

  close() {
    for (const { server } of this.servers.values()) server.close()
    this.servers.clear()
    this.events?.destroy()
    for (const timer of this.timers.values()) clearTimeout(timer)
  }

  private listen(thread: string, dir: string, address: string) {
    const path = join(dir, 'docker.sock')
    try {
      unlinkSync(path)
    } catch {
      // Not there.
    }
    const server = createServer({ allowHalfOpen: true, pauseOnConnect: true }, (client) =>
      this.serve(thread, address, client),
    )
    server.on('error', (error) => console.error(`docker proxy: ${thread}: ${String(error)}`))
    server.listen(path, () => {
      try {
        chmodSync(path, 0o600)
      } catch {
        // Its folder is the teammate's alone anyway.
      }
    })
    return server
  }

  private serve(thread: string, address: string, client: Socket) {
    client.on('error', () => undefined)
    this.connect().then(
      (upstream) => {
        this.watch()
        relay(client, upstream, {
          create: (body) => this.create(body, thread, address),
          started: () => this.publish(thread),
        })
      },
      (error: Error) => {
        const message = JSON.stringify({ message: `Docker did not start: ${error.message}` })
        client.end(
          `HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(message)}\r\nConnection: close\r\n\r\n${message}`,
        )
      },
    )
  }

  /** A connection to the teammate's Docker, started first if it is not running. */
  private async connect(): Promise<Socket> {
    try {
      return await open(this.options.upstream)
    } catch (error) {
      if (!down(error)) throw error
    }
    this.starting ??= this.start().finally(() => {
      this.starting = null
    })
    await this.starting
    return open(this.options.upstream)
  }

  private async start() {
    await this.options.startDocker()
    const until = Date.now() + (this.options.startTimeoutMs ?? 60_000)
    for (;;) {
      try {
        // Answering, not only listening: its socket comes before its API.
        await ping(this.options.upstream)
        return
      } catch (error) {
        if (Date.now() > until) throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }

  private async create(body: Buffer, thread: string, address: string) {
    const create = JSON.parse(body.toString('utf8')) as ContainerCreate
    const imagePorts =
      publishesAll(create) && create.Image ? await this.exposed(create.Image).catch(() => []) : []
    return Buffer.from(JSON.stringify(rewriteCreate(create, thread, address, imagePorts)))
  }

  private async exposed(image: string) {
    // As the docker CLI asks for it: a name with slashes stays one path.
    if (!/^[\w.\/:@-]+$/.test(image)) return []
    return getJson<{ Config?: { ExposedPorts?: Record<string, object> | null } }>(
      this.options.upstream,
      `/images/${image}/json`,
    ).then((inspected) => Object.keys(inspected.Config?.ExposedPorts ?? {}))
  }

  /**
   * The thread's ports, made its own (the helper): resolves once a run that
   * began after this call ended. Calls meanwhile share one run.
   */
  publish(thread: string): Promise<void> {
    const current = this.publishing.get(thread)
    if (current) {
      current.again ??= current.run.then(() => this.publish(thread))
      return current.again
    }
    const run = this.options
      .publish(thread)
      .catch((error: { stderr?: string } & Error) =>
        console.error(
          `docker proxy: ports of ${thread}: ${(error.stderr || error.message).trim()}`,
        ),
      )
      .finally(() => this.publishing.delete(thread))
    this.publishing.set(thread, { run, again: null })
    return run
  }

  private publishSoon(thread: string) {
    if (this.timers.has(thread)) return
    this.timers.set(
      thread,
      setTimeout(() => {
        this.timers.delete(thread)
        void this.publish(thread)
      }, 100),
    )
  }

  /**
   * Docker's events while it runs: a thread's container that starts or stops
   * by itself (a restart policy, a crash) changes its ports too. Once Docker
   * stops, every thread's are put right (none left).
   */
  private watch() {
    if (this.watching) return
    this.watching = true
    const filters = JSON.stringify({
      type: ['container'],
      event: ['start', 'die'],
      label: [THREAD_LABEL],
    })
    const done = () => {
      if (!this.watching) return
      this.watching = false
      for (const thread of this.threads()) this.publishSoon(thread)
    }
    const req = request(
      { socketPath: this.options.upstream, path: `/events?filters=${encodeURIComponent(filters)}` },
      (res) => {
        // What changed while nobody watched (containers Docker started again as it started).
        for (const thread of this.threads()) this.publishSoon(thread)
        let rest = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          const lines = (rest + chunk).split('\n')
          rest = lines.pop() ?? ''
          for (const line of lines) {
            try {
              const event = JSON.parse(line) as { Actor?: { Attributes?: Record<string, string> } }
              const thread = event.Actor?.Attributes?.[THREAD_LABEL]
              if (thread && this.servers.has(thread)) this.publishSoon(thread)
            } catch {
              // Not an event.
            }
          }
        })
        res.on('end', done)
        res.on('error', done)
      },
    )
    req.on('error', done)
    req.on('close', () => {
      if (this.events === req) this.events = null
    })
    this.events = req
    req.end()
  }
}

const down = (error: unknown) =>
  ['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')

function open(path: string) {
  return new Promise<Socket>((resolve, reject) => {
    const socket = connect({ path, allowHalfOpen: true })
    socket.once('connect', () => {
      socket.off('error', reject)
      resolve(socket)
    })
    socket.once('error', reject)
  })
}

function getJson<T>(socketPath: string, path: string) {
  return new Promise<T>((resolve, reject) => {
    const req = request({ socketPath, path, timeout: 10_000 }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => (body += chunk))
      res.on('end', () => {
        if ((res.statusCode ?? 500) >= 300) return reject(new Error(`${res.statusCode}`))
        try {
          resolve(JSON.parse(body) as T)
        } catch (error) {
          reject(error as Error)
        }
      })
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end()
  })
}

const ping = (socketPath: string) =>
  new Promise<void>((resolve, reject) => {
    const req = request({ socketPath, path: '/_ping', timeout: 5_000 }, (res) => {
      res.resume()
      if (res.statusCode === 200) resolve()
      else reject(new Error(`ping ${res.statusCode}`))
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end()
  })

const run = (file: string, args: string[]) =>
  new Promise<void>((resolve, reject) =>
    execFile(file, args, { cwd: '/', timeout: 60_000 }, (error, _stdout, stderr) =>
      error ? reject(Object.assign(error, { stderr })) : resolve(),
    ),
  )

/** As the teammate's user unit (the thread helper's `docker` starts it): until no thread is left. */
function main() {
  const user = userInfo().username
  const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${userInfo().uid}`
  const path = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
  const proxy = new DockerProxy({
    user,
    root: '/run/brigade-docker',
    upstream: `${runtime}/docker.sock`,
    // A unit of the teammate's own systemd: cgroups for its containers (docker pause), and it
    // stays when this proxy goes. Only Docker's own loopback by default: a container published
    // without this proxy is not on the computer's public address.
    startDocker: () =>
      run('systemd-run', [
        '--user',
        '--quiet',
        '--collect',
        '--no-block',
        '--unit=brigade-docker',
        '-p',
        'Type=notify',
        '-p',
        'NotifyAccess=all',
        '-p',
        'Delegate=yes',
        '-p',
        'KillMode=mixed',
        '-E',
        `PATH=${path}`,
        '-E',
        `XDG_RUNTIME_DIR=${runtime}`,
        '-E',
        `DBUS_SESSION_BUS_ADDRESS=${process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${runtime}/bus`}`,
        'dockerd-rootless.sh',
        '--ip=127.0.0.1',
      ]).catch((error: { stderr?: string } & Error) => {
        // Started meanwhile (by another of its threads): its socket is coming.
        if (!/already (exists|loaded)/i.test(error.stderr ?? '')) throw error
      }),
    publish: (thread) =>
      run('sudo', ['-n', '/usr/local/sbin/brigade-thread', 'docker-ports', thread, user]),
    onEmpty: () => process.exit(0),
  })
  process.on('SIGHUP', () => proxy.scan())
  // Threads whose folder went without a signal (the helper's docker-stop sends one).
  setInterval(() => proxy.scan(), 60_000).unref()
  proxy.scan()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
