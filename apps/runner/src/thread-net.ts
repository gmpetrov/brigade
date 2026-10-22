// Each thread's own network on a workspace cloud computer: a network
// namespace per thread (the root thread helper's, installed by the API's
// setup), where its teammates' processes run. Two threads can then run the
// same app on the same ports without reaching each other, its database
// container's published port included: each teammate has one rootless Docker
// for all its threads, and the thread's localhost reaches what its containers
// publish (docker-proxy.ts).
//
// The runner stays outside: it reaches a thread's loopback at the thread's
// address (what the host sends there goes to its 127.0.0.1), for a preview's
// proxy and the harness's bridge. Where there is no helper yet (a computer
// whose setup is older, a member's machine), threads share the computer's
// network as before.
//
// Where the helper can, the same processes also share the thread's own /tmp,
// /var/tmp and /dev/shm, processes and IPC (its holder): two threads' apps use
// the same socket and lock files (PostgreSQL's /tmp/.s.PGSQL.5433, say) without
// colliding, and one's `pkill node` leaves the other's alone. A quiet thread's
// namespaces are taken down once none of its processes is left (takeDown), and
// come back at the same address with its next command.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { CLOUD } from './config.js'

const run = promisify(execFile)
export const THREAD_HELPER = '/usr/local/sbin/brigade-thread'

/**
 * A thread's network: its namespace's name for the helper, its address the host
 * reaches, and whether its /tmp, processes and IPC are its own too.
 */
export type ThreadNet = { thread: string; address: string; isolated?: boolean }

const ENABLED = CLOUD && process.env.BRIGADE_THREAD_NETWORK !== '0'
const nets = new Map<string, Promise<ThreadNet | null>>()
/** Threads whose namespaces were taken down since they were last used. */
const down = new Set<string>()

/**
 * The thread's network, made if needed; null where threads have none (see
 * above) or when the helper failed. Then the thread stays on the computer's
 * network until the runner restarts, so that its preview and its commands
 * never end up on two networks (as when the setup arrives after the runner).
 */
export function threadNet(sessionId: string): Promise<ThreadNet | null> {
  if (!ENABLED) return Promise.resolve(null)
  down.delete(sessionId)
  let net = nets.get(sessionId)
  if (!net) {
    net = run('sudo', ['-n', THREAD_HELPER, 'up', sessionId], { cwd: '/', timeout: 30_000 }).then(
      async ({ stdout }) => ({
        thread: sessionId,
        address: stdout.trim(),
        isolated: await isolate(sessionId),
      }),
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

/** Its holder, started: false with an older helper (the setup arrives after the runner) or when it failed. */
function isolate(sessionId: string) {
  return run('sudo', ['-n', THREAD_HELPER, 'isolate', sessionId], {
    cwd: '/',
    timeout: 30_000,
  }).then(
    () => true,
    (error: { stderr?: string } & Error) => {
      console.warn(
        `thread ${sessionId} shares /tmp and processes: ${(error.stderr || error.message).trim()}`,
      )
      return false
    },
  )
}

/**
 * How to run a command as a teammate: in its thread's namespaces when the
 * thread has them, else as today. All keep the runner's environment (-E).
 */
export function asTeammate(runAs: string, net: ThreadNet | null) {
  if (!net) return { file: 'sudo', args: ['-n', '-E', '-u', runAs, '--'] }
  const how = net.isolated ? 'enter' : 'run'
  return { file: 'sudo', args: ['-n', '-E', THREAD_HELPER, how, net.thread, runAs] }
}

/**
 * Take down a quiet thread's namespaces, keeping its address, once none of its
 * processes is left; with purge (its folder is deleted), its /tmp too. True
 * when they are down; false while something of the thread still runs (another
 * teammate's, say), with an older helper, or when it failed.
 */
export async function takeDown(sessionId: string, purge = false) {
  if (!ENABLED) return false
  if (down.has(sessionId) && !purge) return true
  try {
    await run('sudo', ['-n', THREAD_HELPER, 'down', sessionId, ...(purge ? ['purge'] : [])], {
      cwd: '/',
      timeout: 60_000,
    })
  } catch (error) {
    const { code, stderr } = error as { code?: number; stderr?: string }
    // 3: some of its processes are left; an older helper has no `down`.
    if (code !== 3 && !stderr?.includes('unknown command'))
      console.warn(`could not take down thread ${sessionId}: ${(stderr || String(error)).trim()}`)
    return false
  }
  nets.delete(sessionId)
  down.add(sessionId)
  return true
}

/**
 * The teammate's Docker, as the thread sees it: the socket of its proxy in the
 * thread (docker-proxy.ts), which starts that Docker on first use, or null
 * where the computer has no rootless Docker. What its containers publish there
 * is the thread's.
 */
export async function threadDocker(net: ThreadNet, runAs: string) {
  const { stdout } = await run('sudo', ['-n', THREAD_HELPER, 'docker', net.thread, runAs], {
    cwd: '/',
    timeout: 120_000,
  })
  return stdout.trim() || null
}

/**
 * The teammate's Docker socket in a thread gone, with the thread's ports (its
 * containers are stopped first); with purge, what an older runner's Docker of
 * the thread kept too.
 */
export async function stopThreadDocker(sessionId: string, runAs: string, purge = false) {
  if (!ENABLED) return
  await run(
    'sudo',
    ['-n', THREAD_HELPER, 'docker-stop', sessionId, runAs, ...(purge ? ['purge'] : [])],
    { cwd: '/', timeout: 120_000 },
  )
}

/** Stop the teammate's Docker, its containers with it: none of its threads uses it. */
export async function stopTeammateDocker(runAs: string) {
  if (!ENABLED) return
  await run('sudo', ['-n', THREAD_HELPER, 'docker-down', runAs], { cwd: '/', timeout: 120_000 })
}

/** The teammate's Docker socket in a thread, where the helper puts it. */
export const dockerSocket = (sessionId: string, runAs: string) =>
  `/run/brigade-docker/${sessionId}/${runAs}/docker.sock`

/** Whether the teammate has a Docker socket in the thread (the helper's docker made it). */
export const hasThreadDocker = (sessionId: string, runAs: string) =>
  ENABLED && existsSync(dirname(dockerSocket(sessionId, runAs)))

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
