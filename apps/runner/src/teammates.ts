// On a workspace cloud computer each teammate runs as its own Linux user, so one
// teammate cannot read another's files, or the runner's own token. The root
// helper (installed with the runner) creates users and shares account logins
// with them; it never reads a login.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AccountRef } from '@brigade/contracts'
import { ACCOUNTS_DIR } from './config.js'

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

export const ensureUser = (user: string) => helper('ensure-user', user)

const containers = new Map<string, Promise<Record<string, string>>>()

/**
 * Where the teammate's own rootless Docker answers (the helper starts it once
 * under the teammate's user session), as the environment its processes get:
 * `docker` and `docker compose` then work for it alone. {} where the
 * computer has none; tried again on the next call after a failure.
 */
export function containerEnv(user: string): Promise<Record<string, string>> {
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
