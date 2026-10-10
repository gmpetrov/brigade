// GitHub App webhook. A push to a repository has every online computer of the
// workspaces using that installation fetch it into the caches it already has,
// so the next checkout is quick. Installation changes reach the repository
// lists and the connections' status. Verified by the app's webhook secret.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import { env } from '../config.js'
import { prisma } from '../db.js'
import { forgetInstallation, gitUrl, prefetchToken } from '../git.js'
import { runnerProtocol, sendToRunner } from '../hub.js'

/** Runners from this protocol on know repos.changed. */
const REPOS_CHANGED_PROTOCOL = 5
/** A token each, in one message: enough for any real team on one computer. */
const TEAMMATES_MAX = 50

function signed(body: string, signature: string | undefined) {
  if (!env.GITHUB_APP_WEBHOOK_SECRET || !signature) return false
  const expected = Buffer.from(
    `sha256=${createHmac('sha256', env.GITHUB_APP_WEBHOOK_SECRET).update(body).digest('hex')}`,
  )
  const given = Buffer.from(signature)
  return expected.length === given.length && timingSafeEqual(expected, given)
}

/** The workspaces' connections on this installation (its settings URL ends with its id). */
const connectionsOf = (installationId: number) =>
  prisma.connection.findMany({
    where: {
      kind: 'github',
      status: { not: 'removed' },
      externalUrl: { endsWith: `/installations/${installationId}` },
    },
  })

async function pushed(installationId: number, repository: string) {
  for (const connection of await connectionsOf(installationId)) {
    if (connection.status !== 'active') continue
    const grants = await prisma.grant.findMany({
      where: { connectionId: connection.id, teammate: { archivedAt: null } },
      select: { teammateId: true },
      take: TEAMMATES_MAX,
    })
    if (grants.length === 0) continue
    const computers = await prisma.computer.findMany({
      where: { workspaceId: connection.workspaceId, status: { not: 'destroyed' } },
      select: { id: true },
    })
    for (const computer of computers) {
      // Online only: a push never wakes a stopped computer.
      if ((runnerProtocol(computer.id) ?? 0) < REPOS_CHANGED_PROTOCOL) continue
      sendToRunner(
        computer.id,
        {
          type: 'repos.changed',
          repository: repository.toLowerCase(),
          fetch: grants.map((g) => ({
            teammateId: g.teammateId,
            url: gitUrl(),
            token: prefetchToken(g.teammateId, computer.id),
          })),
        },
        { touch: false },
      )
    }
  }
}

async function installationChanged(installationId: number, action: string) {
  forgetInstallation(installationId)
  const status =
    action === 'deleted' || action === 'suspend'
      ? 'needs_reauth'
      : action === 'unsuspend'
        ? 'active'
        : null
  if (!status) return
  for (const connection of await connectionsOf(installationId))
    await prisma.connection.updateMany({ where: { id: connection.id }, data: { status } })
}

export const githubWebhook = new Hono().post('/', async (c) => {
  if (!env.GITHUB_APP_WEBHOOK_SECRET) return c.json({ error: 'Not configured' }, 404)
  const body = await c.req.text()
  if (!signed(body, c.req.header('x-hub-signature-256')))
    return c.json({ error: 'Bad signature' }, 401)
  const event = c.req.header('x-github-event')
  const payload = JSON.parse(body) as {
    action?: string
    installation?: { id?: number }
    repository?: { full_name?: string }
    deleted?: boolean
  }
  const installationId = payload.installation?.id
  if (!installationId) return c.body(null, 204)
  // Answer at once; GitHub waits ten seconds at most.
  const work =
    event === 'push' && payload.repository?.full_name && !payload.deleted
      ? pushed(installationId, payload.repository.full_name)
      : event === 'installation_repositories'
        ? installationChanged(installationId, 'repositories')
        : event === 'installation' && payload.action
          ? installationChanged(installationId, payload.action)
          : null
  void work?.catch((error) => console.error(`github webhook ${event} failed:`, error))
  return c.body(null, 202)
})
