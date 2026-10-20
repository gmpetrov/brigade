// On a workspace cloud computer each teammate runs as its own Linux user, so one
// teammate cannot read another's files, or the runner's own token. The root
// helper (installed with the runner) creates users and shares account logins
// with them; it never reads a login.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AccountRef } from '@brigade/contracts'
import { ACCOUNTS_DIR } from './config.js'
import { threadDocker, threadNet, type ThreadNet } from './thread-net.js'

const run = promisify(execFile)
const HELPER = '/usr/local/sbin/brigade-teammate'

/** The Linux user of a teammate. Teammate ids are lowercase cuids. */
export function teammateUser(teammateId: string) {
  const user = `bt-${teammateId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 28)}`
  if (user.length < 4) throw new Error('Invalid teammate id')
  return user
}

export const teammateHome = (user: string) => `/home/${user}`

async function helper(...args: string[]) {
  await run('sudo', ['-n', HELPER, ...args], { cwd: '/' })
}

const users = new Map<string, Promise<void>>()

/** Once per user: a thread's turn and its title run may both ask at the same time. */
export function ensureUser(user: string) {
  let made = users.get(user)
  if (!made) {
    made = helper('ensure-user', user)
    made.catch(() => users.delete(user))
    users.set(user, made)
  }
  return made
}

const containers = new Map<string, Promise<Record<string, string>>>()

/**
 * Docker Compose names a project after its folder, so every thread's checkout
 * of a repository would share one: its containers and its database volume. On
 * a member's machine, so would the member's own clone, named the same: a
 * `docker compose down -v` in a thread would delete their database. One
 * project per thread instead.
 */
export const composeProject = (sessionId: string) =>
  `t${sessionId.toLowerCase().replace(/[^a-z0-9]/g, '')}`

/**
 * The environment a teammate's processes in a thread get: its own Docker
 * (see dockerEnv), with the thread's Compose project.
 */
export async function containerEnv(user: string, sessionId: string) {
  const net = await threadNet(sessionId)
  const env = net ? await threadDockerEnv(net, user) : await dockerEnv(user)
  return env.DOCKER_HOST ? { ...env, COMPOSE_PROJECT_NAME: composeProject(sessionId) } : env
}

/**
 * In a thread with its own network, the teammate's Docker of that thread (see
 * thread-net.ts): what its containers publish is the thread's. {} without one,
 * or when it did not start (said in the runner's log).
 */
async function threadDockerEnv(net: ThreadNet, user: string): Promise<Record<string, string>> {
  const socket = await threadDocker(net, user).catch((error: { stderr?: string } & Error) => {
    console.warn(
      `no Docker for ${user} in ${net.thread}: ${(error.stderr || error.message).trim()}`,
    )
    return null
  })
  return socket ? { DOCKER_HOST: `unix://${socket}` } : {}
}

/**
 * Where the teammate's own rootless Docker answers (the helper starts it once
 * under the teammate's user session), as the environment its processes get:
 * `docker` and `docker compose` then work for it alone. {} where the
 * computer has none; tried again on the next call after a failure.
 */
export function dockerEnv(user: string): Promise<Record<string, string>> {
  let env = containers.get(user)
  if (!env) {
    env = run('sudo', ['-n', HELPER, 'containers', user], { cwd: '/', timeout: 120_000 }).then(
      ({ stdout }): Record<string, string> => {
        const uid = stdout.trim()
        return /^\d+$/.test(uid)
          ? {
              XDG_RUNTIME_DIR: `/run/user/${uid}`,
              DOCKER_HOST: `unix:///run/user/${uid}/docker.sock`,
            }
          : {}
      },
      (error: { stderr?: string } & Error): Record<string, string> => {
        console.warn(`no Docker for ${user}: ${(error.stderr || error.message).trim()}`)
        containers.delete(user)
        return {}
      },
    )
    containers.set(user, env)
  }
  return env
}

export const shareAccount = (accountId: string) => helper('share-account', accountId)

/**
 * Free what the computer's own Docker keeps for nothing (prune-system-docker): images
 * pulled there outside the teammates' rootless Dockers. Says how much it freed.
 */
export async function pruneSystemDocker() {
  const { stdout } = await run('sudo', ['-n', HELPER, 'prune-system-docker'], { cwd: '/' })
  return stdout.trim()
}

/**
 * The teammate's own config directory for an account: private (its sessions
 * and history), sharing only the login file with the account directory.
 */
export async function linkAccount(
  user: string,
  account: AccountRef,
): Promise<Record<string, string>> {
  if (account.source !== 'brigade')
    throw new Error('Only accounts signed in through Brigade can run on a cloud computer')
  await helper('link-account', user, account.id, account.provider)
  const dir = `${teammateHome(user)}/.accounts/${account.id}`
  return account.provider === 'codex' ? { CODEX_HOME: dir } : { CLAUDE_CONFIG_DIR: dir }
}

export { ACCOUNTS_DIR }
