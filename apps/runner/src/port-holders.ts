// Who holds a port on a member's machine, said in words: a preview that cannot
// have its port, or whose app or `docker compose up` fails because a port is
// taken, names what has it. There threads have no network of their own, so
// another thread's app or containers, or the member's own (their dev stack,
// macOS's AirPlay Receiver on 5000 and 7000), can hold the ports an app wants.
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { HOME } from './config.js'
import { composeProject } from './teammates.js'

const run = promisify(execFile)

/** A process listening on the port, and the container behind it when it forwards one. */
export type PortHolder = {
  pid: number
  command: string
  cwd?: string
  container?: { name: string; project?: string; dir?: string }
}

/** What forwards a container's published ports on a Mac: Docker Desktop, OrbStack, Colima, Podman… */
const FORWARDER = /docker|vpnkit|orbstack|limactl|colima|podman|rancher|lima/i

/** The ports a log says were taken: Node's EADDRINUSE, Docker's "port is already allocated", and the like. */
export function takenPorts(log: string): number[] {
  const ports = new Set<number>()
  for (const line of log.split('\n')) {
    if (!/EADDRINUSE|already (in use|allocated)|ports are not available/i.test(line)) continue
    for (const match of line.matchAll(/(?::|\bport\s+"?)(\d{2,5})(?!\d)/gi)) {
      const port = Number(match[1])
      // Below 80: a time in the line (12:03:45), not a port an app wants.
      if (port >= 80 && port <= 65535) ports.add(port)
    }
  }
  return [...ports].slice(0, 3)
}

/** What listens on a TCP port here, by process (lsof), and the container it forwards to. */
export async function portHolders(port: number): Promise<PortHolder[]> {
  const out = await run('lsof', ['+c', '0', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'], {
    timeout: 10_000,
  }).then(
    (r) => r.stdout,
    // lsof exits 1 when nothing listens.
    (error: { stdout?: string }) => error.stdout ?? '',
  )
  const holders: PortHolder[] = []
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) holders.push({ pid: Number(line.slice(1)), command: '' })
    else if (line.startsWith('c') && holders.length) holders.at(-1)!.command = line.slice(1)
  }
  for (const holder of holders) {
    const cwd = await run('lsof', ['-a', '-p', String(holder.pid), '-d', 'cwd', '-Fn'], {
      timeout: 10_000,
    }).then(
      (r) => /^n(.+)$/m.exec(r.stdout)?.[1],
      () => undefined,
    )
    if (cwd) holder.cwd = cwd
    if (FORWARDER.test(holder.command)) {
      const container = await publishedBy(port)
      if (container) holder.container = container
    }
  }
  return holders
}

/** The container that publishes the port, from the Docker the member's shell uses. */
async function publishedBy(port: number) {
  const out = await run(
    'docker',
    [
      'ps',
      '--filter',
      `publish=${port}`,
      '--format',
      '{{.Names}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.project.working_dir"}}',
    ],
    { timeout: 10_000 },
  ).then(
    (r) => r.stdout.trim().split('\n')[0] ?? '',
    () => '',
  )
  const [name, project, dir] = out.split('\t')
  return name ? { name, ...(project ? { project } : {}), ...(dir ? { dir } : {}) } : null
}

/** Whose a holder is, for a thread: its own, another thread's, or the member's (or macOS's). */
export function holderOwner(holder: PortHolder, sessionId: string): 'thread' | 'other' {
  const own = composeProject(sessionId)
  if (holder.container) return holder.container.project === own ? 'thread' : 'other'
  const threads = join(HOME, 'teammates')
  const thread = holder.cwd?.startsWith(`${threads}/`)
    ? /\/threads\/([^/]+)/.exec(holder.cwd.slice(threads.length))?.[1]
    : undefined
  return thread === sessionId ? 'thread' : 'other'
}

/** A holder in words, for a thread's teammate and the person. */
export function describeHolder(holder: PortHolder, sessionId: string): string {
  const { container } = holder
  if (container) {
    const project = container.project
    if (project === composeProject(sessionId)) return `this thread's container ${container.name}`
    if (project && /^t[a-z0-9]+$/.test(project))
      return `container ${container.name} of another thread (Compose project ${project})`
    return (
      `the member's own container ${container.name}` +
      (project ? ` (Compose project ${project}${container.dir ? ` in ${container.dir}` : ''})` : '')
    )
  }
  if (/^ControlCe/.test(holder.command))
    return "macOS's AirPlay Receiver (ControlCenter; it can be turned off in System Settings, General, AirDrop & Handoff)"
  const threads = join(HOME, 'teammates')
  if (holder.cwd?.startsWith(`${threads}/`))
    return holderOwner(holder, sessionId) === 'thread'
      ? `${holder.command} (pid ${holder.pid}), which this thread started`
      : `${holder.command} (pid ${holder.pid}) of another thread`
  return `${holder.command || 'a process'} (pid ${holder.pid}${holder.cwd && holder.cwd !== '/' ? `, in ${holder.cwd}` : ''})`
}

/** Who holds the port, in words; null when nothing listens now or it cannot be told. */
export async function whoHolds(port: number, sessionId: string) {
  const holders = await portHolders(port).catch(() => [])
  if (holders.length === 0) return null
  // A forwarder that says which container is clearer than its sibling processes.
  const best = holders.find((h) => h.container) ?? holders[0]!
  return { holder: best, text: describeHolder(best, sessionId) }
}
