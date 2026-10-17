// Each thread's own network on a workspace cloud computer: a network
// namespace per thread (the root thread helper's, installed by the API's
// setup), where its teammates' processes run, with a rootless Docker per
// teammate in it. Two threads can then run the same app on the same ports, its
// database container's published port included, without reaching each other.
//
// The runner stays outside: it reaches a thread's loopback at the thread's
// address (what the host sends there goes to its 127.0.0.1), for a preview's
// proxy and the harness's bridge. Where there is no helper yet (a computer
// whose setup is older, a member's machine), threads share the computer's
// network as before.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { CLOUD } from './config.js'

const run = promisify(execFile)
export const THREAD_HELPER = '/usr/local/sbin/brigade-thread'

/** A thread's network: its namespace's name for the helper, and its address the host reaches. */
export type ThreadNet = { thread: string; address: string }

const ENABLED = CLOUD && process.env.BRIGADE_THREAD_NETWORK !== '0'
const nets = new Map<string, Promise<ThreadNet | null>>()

/**
 * The thread's network, made if needed; null where threads have none (see
 * above) or when the helper failed. Then the thread stays on the computer's
 * network until the runner restarts, so that its preview and its commands
 * never end up on two networks (as when the setup arrives after the runner).
 */
export function threadNet(sessionId: string): Promise<ThreadNet | null> {
  if (!ENABLED) return Promise.resolve(null)
  let net = nets.get(sessionId)
  if (!net) {
    net = run('sudo', ['-n', THREAD_HELPER, 'up', sessionId], { cwd: '/', timeout: 30_000 }).then(
      ({ stdout }) => ({ thread: sessionId, address: stdout.trim() }),
      (error: { stderr?: string } & Error) => {
        console.warn(
          `thread ${sessionId} runs on the computer's network: ${(error.stderr || error.message).trim()}`,
        )
        return null
      },
    )
    nets.set(sessionId, net)
  }
  return net
}

/**
 * How to run a command as a teammate: in its thread's namespace when the
 * thread has one, else as today. Both keep the runner's environment (-E).
 */
export function asTeammate(runAs: string, net: ThreadNet | null) {
  return net
    ? { file: 'sudo', args: ['-n', '-E', THREAD_HELPER, 'run', net.thread, runAs] }
    : { file: 'sudo', args: ['-n', '-E', '-u', runAs, '--'] }
}

/**
 * The teammate's own Docker in the thread, started if needed: its socket, or
 * null where the computer has no rootless Docker.
 */
export async function threadDocker(net: ThreadNet, runAs: string) {
  const { stdout } = await run('sudo', ['-n', THREAD_HELPER, 'docker', net.thread, runAs], {
    cwd: '/',
    timeout: 120_000,
  })
  return stdout.trim() || null
}

/** Stop the teammate's Docker in a thread; with purge, delete its images, containers and volumes too. */
export async function stopThreadDocker(sessionId: string, runAs: string, purge = false) {
  if (!ENABLED) return
  await run(
    'sudo',
    ['-n', THREAD_HELPER, 'docker-stop', sessionId, runAs, ...(purge ? ['purge'] : [])],
    { cwd: '/', timeout: 120_000 },
  )
}

/**
 * Freeze the teammate's Docker in a thread, its containers with it, and give
 * its memory back; or thaw it. For a frozen preview's database, say.
 */
export async function freezeThreadDocker(sessionId: string, runAs: string, frozen: boolean) {
  await run(
    'sudo',
    ['-n', THREAD_HELPER, frozen ? 'docker-freeze' : 'docker-thaw', sessionId, runAs],
    { cwd: '/', timeout: 60_000 },
  )
}

/** The unit of a teammate's Docker in a thread (systemd's, outside the runner's own). */
export const dockerUnit = (sessionId: string, runAs: string) =>
  `brigade-docker-${sessionId}-${runAs}.service`

/** Its socket, where the helper puts it. */
export const dockerSocket = (sessionId: string, runAs: string) =>
  `/run/brigade-docker/${sessionId}/${runAs}/docker.sock`

/** The threads whose Docker of this teammate is running, from systemd. */
export async function runningThreadDockers(runAs: string): Promise<string[]> {
  const { stdout } = await run(
    'systemctl',
    ['list-units', '--plain', '--no-legend', '--state=active', `brigade-docker-*-${runAs}.service`],
    { cwd: '/' },
  ).catch(() => ({ stdout: '' }))
  return threadsOfUnits(stdout, runAs)
}

/** The threads in systemctl's listing of a teammate's Docker units (dockerUnit's names). */
export function threadsOfUnits(listing: string, runAs: string) {
  const prefix = 'brigade-docker-'
  const suffix = `-${runAs}.service`
  return listing
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[0] ?? '')
    .filter((unit) => unit.startsWith(prefix) && unit.endsWith(suffix))
    .map((unit) => unit.slice(prefix.length, -suffix.length))
    .filter(Boolean)
}

/**
 * The teammate's browser on the host's loopback, reachable from the thread's
 * namespace at the same address and port, by the teammate's user only.
 */
export async function bridgeBrowser(net: ThreadNet, runAs: string) {
  await run('sudo', ['-n', THREAD_HELPER, 'browser', net.thread, runAs], {
    cwd: '/',
    timeout: 30_000,
  })
}
