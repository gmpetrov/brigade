// Git for teammates, through the API (spec hard constraint 4: the GitHub
// credential never leaves this process). A thread's spec carries a token for
// this proxy, limited to that thread and teammate; each request is checked
// against the teammate's GitHub grants, and pushes only reach brigade/ branches.
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto'
import type { GitAccess, PermissionPolicy, ProjectSpec } from '@brigade/contracts'
import { writeCapReached } from './caps.js'
import { env } from './config.js'
import {
  GITHUB_API,
  GitHubInstallationGone,
  githubHeaders,
  installationToken,
  type GitHubCredential,
} from './connectors/github-app.js'
import { prisma, scoped, type Scope, type ScopedDb } from './db.js'
import { openSecret } from './vault.js'

/** Teammates push only to branches under this prefix; a pull request takes them further. */
export const PUSH_PREFIX = 'refs/heads/brigade/'
/** Where the runner backs up uncommitted work when a thread goes idle. */
export const BACKUP_PREFIX = 'refs/heads/brigade/wip/'

/** Long enough for a harness session that stays live for days; each request is checked anyway. */
const TOKEN_DAYS = 7
/** A fetch-only token for refreshing a computer's caches after a push on GitHub. */
const PREFETCH_SECONDS = 10 * 60
const KEY = Buffer.from(
  hkdfSync('sha256', env.BETTER_AUTH_SECRET, 'brigade', 'git proxy token', 32),
)
const ID = /^[A-Za-z0-9_-]{1,64}$/

/** sessionId null: a fetch-only token outside any thread, for refreshing caches. */
type Claims = { sessionId: string | null; teammateId: string; computerId: string }

const sign = (payload: string) => createHmac('sha256', KEY).update(payload).digest('base64url')

function mint(claims: Claims, seconds: number) {
  const expires = Math.floor(Date.now() / 1000) + seconds
  const payload = Buffer.from(
    [claims.sessionId ?? '', claims.teammateId, claims.computerId, expires].join('.'),
  ).toString('base64url')
  return `bgit_${payload}.${sign(payload)}`
}

export const gitUrl = () => `${env.API_URL}/git/`

/** What a thread's teammate gets to use git: the proxy, its token, its commit identity and the projects. */
export function gitAccess(
  claims: Claims & { sessionId: string },
  teammate: { name: string },
  projects: ProjectSpec[],
): GitAccess {
  return {
    url: gitUrl(),
    token: mint(claims, TOKEN_DAYS * 86_400),
    author: { name: teammate.name, email: `${claims.teammateId}@teammates.brigade.invalid` },
    projects,
  }
}

/** A short fetch-only token for a teammate's caches on a computer. */
export const prefetchToken = (teammateId: string, computerId: string) =>
  mint({ sessionId: null, teammateId, computerId }, PREFETCH_SECONDS)

function verify(token: string): Claims | null {
  const [payload, signature] = token.replace(/^bgit_/, '').split('.')
  if (!payload || !signature) return null
  const expected = Buffer.from(sign(payload))
  const given = Buffer.from(signature)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
  const [sessionId, teammateId, computerId, expires] = Buffer.from(payload, 'base64url')
    .toString()
    .split('.')
  if (![teammateId, computerId].every((id) => id && ID.test(id))) return null
  if (sessionId === undefined || (sessionId !== '' && !ID.test(sessionId))) return null
  if (!(Number(expires) > Date.now() / 1000)) return null
  return { sessionId: sessionId || null, teammateId: teammateId!, computerId: computerId! }
}

/** The token from git's request: our bearer header, or a password someone configured by hand. */
export function tokenFrom(authorization: string | undefined) {
  if (!authorization) return null
  const bearer = authorization.match(/^Bearer (\S+)$/)?.[1]
  if (bearer) return bearer
  const basic = authorization.match(/^Basic (\S+)$/)?.[1]
  const password = basic && Buffer.from(basic, 'base64').toString().split(':').slice(1).join(':')
  return password || null
}

export class GitRefused extends Error {}

type Repository = { fullName: string; private: boolean }
const REPOS_TTL_MS = 5 * 60_000
const repoLists = new Map<number, { repos: Map<string, Repository>; until: number }>()

/** The installation's repositories changed on GitHub: list them again on the next request. */
export const forgetInstallation = (installationId: number) => repoLists.delete(installationId)

/** The repositories an installation reaches, cached for a few minutes. */
async function installationRepos(installationId: number) {
  const cached = repoLists.get(installationId)
  if (cached && cached.until > Date.now()) return cached.repos
  const token = await installationToken(installationId)
  const repos = new Map<string, Repository>()
  for (let page = 1; page <= 50; page++) {
    const response = await fetch(
      `${GITHUB_API}/installation/repositories?per_page=100&page=${page}`,
      { headers: { ...githubHeaders, authorization: `Bearer ${token}` } },
    )
    if (!response.ok) throw new Error(`GitHub refused the repository list (${response.status})`)
    const body = (await response.json()) as {
      repositories: { full_name: string; private: boolean }[]
    }
    for (const r of body.repositories)
      repos.set(r.full_name.toLowerCase(), { fullName: r.full_name, private: r.private })
    if (body.repositories.length < 100) break
  }
  repoLists.set(installationId, { repos, until: Date.now() + REPOS_TTL_MS })
  return repos
}

/**
 * Every repository the workspace's GitHub connections reach, for picking a
 * project. A connection whose installation is gone is marked for reconnecting.
 */
export async function workspaceRepositories(db: ScopedDb, scope: Scope) {
  const connections = await db.connection.findMany({
    where: { kind: 'github', status: 'active', vaultSecretId: { not: null } },
  })
  const found = new Map<string, { repository: string; private: boolean; connection: string }>()
  for (const connection of connections) {
    const { installationId } = await openSecret<GitHubCredential>(
      db,
      scope,
      connection.vaultSecretId!,
    )
    try {
      for (const [key, repo] of await installationRepos(installationId))
        if (!found.has(key))
          found.set(key, {
            repository: key,
            private: repo.private,
            connection: connection.externalAccount ?? connection.label,
          })
    } catch (error) {
      if (!(error instanceof GitHubInstallationGone)) throw error
      await db.connection.updateMany({
        where: { id: connection.id },
        data: { status: 'needs_reauth' },
      })
    }
  }
  return [...found.values()].sort((a, b) => a.repository.localeCompare(b.repository))
}

const publicRepos = new Map<string, { fullName: string | null; until: number }>()

/** A public repository's name as GitHub spells it, or null. Read with any installation's token. */
async function publicRepo(repo: string, installationId: number) {
  const cached = publicRepos.get(repo)
  if (cached && cached.until > Date.now()) return cached.fullName
  const response = await fetch(`${GITHUB_API}/repos/${repo}`, {
    headers: {
      ...githubHeaders,
      authorization: `Bearer ${await installationToken(installationId)}`,
    },
  })
  const body = response.ok
    ? ((await response.json()) as { full_name: string; private: boolean })
    : null
  const fullName = body && !body.private ? body.full_name : null
  publicRepos.set(repo, { fullName, until: Date.now() + REPOS_TTL_MS })
  return fullName
}

/** Who is asking and what they reach. Through a connection, or (reads only) a public repository. */
export type GitRequest = {
  scope: Scope
  db: ScopedDb
  /** Unset for a fetch-only token outside any thread. */
  session?: { id: string; origin: string }
  teammate: { id: string; name: string; caps: unknown; permissionPolicy: unknown }
  fullName: string
  /** Unset for a public repository no connection reaches: anonymous reads only. */
  via?: {
    connectionId: string
    installationId: number
    write: boolean
  }
}

/**
 * Check a proxy request: a valid token for a thread on its computer, a teammate
 * still in it, and a GitHub grant whose installation reaches the repository.
 */
export async function authorize(
  authorization: string | undefined,
  owner: string,
  name: string,
): Promise<GitRequest> {
  const token = tokenFrom(authorization)
  const claims = token ? verify(token) : null
  if (!claims)
    throw new GitRefused('Brigade: this git token is invalid or expired; start a new turn')
  const runner = await prisma.runner.findUnique({ where: { computerId: claims.computerId } })
  if (!runner) throw new GitRefused('Brigade: unknown computer')
  const scope = { organizationId: runner.organizationId, workspaceId: runner.workspaceId }
  const db = scoped(scope)
  let session: GitRequest['session']
  let teammate: GitRequest['teammate'] | null
  if (claims.sessionId) {
    session =
      (await db.session.findFirst({
        where: { id: claims.sessionId, computerId: claims.computerId },
      })) ?? undefined
    if (!session) throw new GitRefused('Brigade: unknown thread')
    const seat = await db.threadTeammate.findFirst({
      where: { sessionId: session.id, teammateId: claims.teammateId },
      include: { teammate: true },
    })
    teammate = seat?.teammate ?? null
    if (!teammate) throw new GitRefused('Brigade: that teammate is not in this thread')
  } else {
    teammate = await db.teammate.findFirst({ where: { id: claims.teammateId, archivedAt: null } })
    if (!teammate) throw new GitRefused('Brigade: unknown teammate')
  }

  const repo = `${owner}/${name}`.toLowerCase()
  const grants = await db.grant.findMany({
    where: { teammateId: teammate.id, connection: { kind: 'github', status: 'active' } },
    include: { connection: true },
    orderBy: { createdAt: 'asc' },
  })
  let someInstallation: number | undefined
  for (const grant of grants) {
    if (!grant.connection.vaultSecretId) continue
    const { installationId } = await openSecret<GitHubCredential>(
      db,
      scope,
      grant.connection.vaultSecretId,
    )
    try {
      const found = (await installationRepos(installationId)).get(repo)
      someInstallation ??= installationId
      if (found)
        return {
          scope,
          db,
          session,
          teammate,
          fullName: found.fullName,
          via: {
            connectionId: grant.connection.id,
            installationId,
            write: grant.scope === 'read_write',
          },
        }
    } catch (error) {
      if (!(error instanceof GitHubInstallationGone)) throw error
      await db.connection.updateMany({
        where: { id: grant.connection.id },
        data: { status: 'needs_reauth' },
      })
    }
  }
  // Dependencies fetched from public repositories keep working.
  const fullName = someInstallation && (await publicRepo(repo, someInstallation))
  if (fullName) return { scope, db, session, teammate, fullName }
  throw new GitRefused(
    `Brigade: ${teammate.name} has no GitHub connection that reaches ${owner}/${name}. ` +
      'A person can install the GitHub app on it and grant the connection.',
  )
}

/** Why the teammate may not push at all, or null. Checked before any ref is known. */
export function pushRefusal(request: GitRequest) {
  const { teammate, via, fullName } = request
  if (!request.session) return 'Brigade: this token only fetches'
  if (!via) return `Brigade: ${fullName} is public and not in a GitHub connection; it is read-only`
  if (!via.write) return `Brigade: ${teammate.name} has read-only access to this GitHub connection`
  const policy = (teammate.permissionPolicy as PermissionPolicy).connectorWrites ?? 'ask'
  if (policy === 'deny') return `Brigade: ${teammate.name} may not make changes through connectors`
  return null
}

/** Why one pushed ref is refused, or null. */
export async function refRefusal(request: GitRequest, ref: string, backup: boolean) {
  if (!ref.startsWith(PUSH_PREFIX) || ref.includes('..'))
    return 'teammates push only to branches under brigade/; open a pull request for the rest'
  if (backup || !request.via) return null
  const cap = await writeCapReached(request.db, request.teammate, request.via.connectionId)
  return cap ? `${request.teammate.name} reached its cap of ${cap.limit} write calls today` : null
}

/** Basic auth for github.com's git endpoints, minted here and never sent anywhere else. */
export async function upstreamAuthorization(request: GitRequest, fresh = false) {
  if (!request.via) return undefined
  const token = await installationToken(request.via.installationId, fresh)
  return `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
}

/** One row in the connection's call log. Anonymous reads of public repositories have no connection. */
export async function recordGit(
  request: GitRequest,
  call: { operation: string; write: boolean; target: string; result: string; error?: string },
) {
  // Cache refreshes outside a thread are Brigade's own, like the library mirror: not in a thread's log.
  if (!request.via || !request.session) return
  await request.db.connectionCall.create({
    data: {
      sessionId: request.session.id,
      connectionId: request.via.connectionId,
      teammateId: request.teammate.id,
      ...call,
      target: call.target.slice(0, 500),
      ...(call.error ? { error: call.error.slice(0, 1000) } : {}),
    } as never,
  })
}

// ---------------------------------------------------------------------------
// pkt-line, for reading a push's commands and refusing them in git's own terms
// ---------------------------------------------------------------------------

export type PushCommand = { old: string; new: string; ref: string }

const COMMANDS_MAX = 1024 * 1024

/**
 * Read a receive-pack request up to the end of its command list. Returns the
 * commands, the client's capabilities, and a body that replays every byte.
 */
export async function readPush(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  let buffer = Buffer.alloc(0)
  let offset = 0
  const commands: PushCommand[] = []
  let capabilities: string[] = []
  for (;;) {
    while (buffer.length - offset >= 4) {
      const length = parseInt(buffer.subarray(offset, offset + 4).toString(), 16)
      if (Number.isNaN(length)) throw new GitRefused('Brigade: malformed push')
      if (length === 0) {
        // The flush after the command list: the pack (if any) follows.
        const prefix = buffer
        const replay = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(prefix)
          },
          async pull(controller) {
            const { done, value } = await reader.read()
            if (done) controller.close()
            else controller.enqueue(value)
          },
          cancel: (reason) => reader.cancel(reason),
        })
        return { commands, capabilities, body: replay, drain: () => drain(reader) }
      }
      if (length < 4) throw new GitRefused('Brigade: malformed push')
      if (buffer.length - offset < length) break
      let line = buffer
        .subarray(offset + 4, offset + length)
        .toString()
        .replace(/\n$/, '')
      offset += length
      const nul = line.indexOf('\0')
      if (nul >= 0) {
        capabilities = line
          .slice(nul + 1)
          .split(' ')
          .filter(Boolean)
        line = line.slice(0, nul)
      }
      if (line.startsWith('shallow ')) continue
      const [old, next, ref] = line.split(' ')
      if (!old || !next || !ref || line.startsWith('push-cert'))
        throw new GitRefused('Brigade: unsupported push (signed pushes are not proxied)')
      commands.push({ old, new: next, ref })
    }
    if (buffer.length > COMMANDS_MAX) throw new GitRefused('Brigade: push command list too long')
    const { done, value } = await reader.read()
    if (done) throw new GitRefused('Brigade: incomplete push')
    buffer = Buffer.concat([buffer, value])
  }
}

async function drain(reader: ReadableStreamDefaultReader<Uint8Array>) {
  while (!(await reader.read()).done);
}

const pkt = (data: string | Buffer) => {
  const bytes = typeof data === 'string' ? Buffer.from(data) : data
  return Buffer.concat([Buffer.from((bytes.length + 4).toString(16).padStart(4, '0')), bytes])
}

/**
 * A receive-pack answer that refuses every ref, as GitHub does for a protected
 * branch: git shows "! [remote rejected] <ref> (<reason>)" and our message.
 */
export function refusePush(
  commands: PushCommand[],
  capabilities: string[],
  reasons: Map<string, string>,
) {
  const status = Buffer.concat([
    pkt('unpack ok\n'),
    ...commands.map((c) => pkt(`ng ${c.ref} ${reasons.get(c.ref) ?? 'refused with the others'}\n`)),
    Buffer.from('0000'),
  ])
  const message = `Brigade: ${[...new Set(reasons.values())].join('; ')}\n`
  if (!capabilities.includes('side-band-64k') && !capabilities.includes('side-band')) return status
  const max = capabilities.includes('side-band-64k') ? 65_515 : 995
  const parts = [pkt(Buffer.concat([Buffer.from([2]), Buffer.from(message)]))]
  for (let i = 0; i < status.length; i += max)
    parts.push(pkt(Buffer.concat([Buffer.from([1]), status.subarray(i, i + max)])))
  parts.push(Buffer.from('0000'))
  return Buffer.concat(parts)
}
