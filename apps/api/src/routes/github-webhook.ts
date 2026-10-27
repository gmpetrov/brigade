// GitHub App webhook. A push to a repository has every online computer of the
// workspaces using that installation fetch it into the caches it already has,
// so the next checkout is quick. Installation changes reach the repository
// lists and the connections' status, and events start threads for the
// connections' triggers (see triggers.ts). A pull request closing or merging
// updates Brigade's copy of it, which can finish the task that opened it.
// Verified by the app's webhook secret, then kept (src/inbound.ts) and answered at once: GitHub
// does not retry, so each delivery is processed from its row, again until it went through. One
// GitHub could not deliver at all (the API was down) is asked for again (redeliverFailed).
import { createHmac, timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import { env } from '../config.js'
import { githubConfigured, hookDeliveries, redeliverHook } from '../connectors/github-app.js'
import { prisma, scoped } from '../db.js'
import { forgetInstallation, gitUrl, prefetchToken } from '../git.js'
import { hubs } from '../hub.js'
import { keepInbound, onInbound } from '../inbound.js'
import { noteFailure } from '../ops/failures.js'
import { pullRequestEvent, type GhPull } from '../pull-requests.js'
import { dispatch } from '../triggers.js'

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
    // A member's own account reaches only their threads: nothing is fetched ahead onto computers.
    if (connection.status !== 'active' || connection.reach === 'mine') continue
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
    const hub = hubs.get(connection.workspaceId)
    const presence = await hub.presence(computers.map((c) => c.id))
    for (const computer of computers) {
      // Online only: a push never wakes a stopped computer.
      if ((presence[computer.id]?.protocolVersion ?? 0) < REPOS_CHANGED_PROTOCOL) continue
      await hub.sendToRunner(
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
  // Scoped, so dashboards hear of it (src/hub.ts).
  for (const connection of await connectionsOf(installationId))
    await scoped(connection).connection.updateMany({
      where: { id: connection.id },
      data: { status },
    })
}

async function pullRequestChanged(installationId: number, repository: string, pull: GhPull) {
  for (const connection of await connectionsOf(installationId))
    await pullRequestEvent(
      { organizationId: connection.organizationId, workspaceId: connection.workspaceId },
      repository,
      pull,
    )
}

/**
 * Offer the event to the triggers of every workspace's connection on this
 * installation. What Brigade's own app did (a teammate's push or comment)
 * starts nothing, so a thread never triggers itself.
 */
async function triggered(
  installationId: number,
  type: string,
  deliveryId: string,
  payload: { sender?: { type?: string; login?: string } },
) {
  if (payload.sender?.type === 'Bot' && payload.sender.login === `${env.GITHUB_APP_SLUG}[bot]`)
    return false
  let failed = false
  for (const connection of await connectionsOf(installationId)) {
    // A member's own account reaches only their threads: nothing is fetched ahead onto computers.
    if (connection.status !== 'active' || connection.reach === 'mine') continue
    // A thread that could not start leaves a ticket (see deliver), and the event is tried again;
    // a trigger it reached already does not take it twice.
    failed = (await dispatch(connection, { id: deliveryId, type, payload })).failed || failed
  }
  return failed
}

type Payload = {
  action?: string
  sender?: { type?: string; login?: string }
  installation?: { id?: number }
  repository?: { full_name?: string }
  deleted?: boolean
  pull_request?: GhPull
}

/** One delivery, from its row: the caches, installations and pull requests, then the triggers. */
onInbound('github', async ({ externalId, type: event, payload: raw }) => {
  const payload = raw as Payload
  const installationId = payload.installation?.id
  if (!installationId) return 'done'
  if (event === 'push' && payload.repository?.full_name && !payload.deleted)
    await pushed(installationId, payload.repository.full_name)
  else if (event === 'installation_repositories')
    await installationChanged(installationId, 'repositories')
  else if (event === 'installation' && payload.action)
    await installationChanged(installationId, payload.action)
  else if (
    event === 'pull_request' &&
    (payload.action === 'closed' || payload.action === 'reopened') &&
    payload.repository?.full_name &&
    payload.pull_request
  )
    await pullRequestChanged(installationId, payload.repository.full_name, payload.pull_request)
  const failed = await triggered(
    installationId,
    payload.action ? `${event}.${payload.action}` : event,
    externalId,
    payload,
  )
  return failed ? 'retry' : 'done'
})

/** How far back failed deliveries are looked for: GitHub keeps them three days. */
const REDELIVER_WITHIN_MS = 6 * 60 * 60_000
/** An attempt younger than this may still be on its way. */
const REDELIVER_AFTER_MS = 2 * 60_000
/** At most this many asked for again per run. */
const REDELIVER_MAX = 20

/**
 * Deliveries GitHub could not make (the API was down or answered an error) and Brigade never
 * kept: asked for again, through the app's API. Each ten minutes (src/jobs.ts).
 */
export async function redeliverFailed(now = Date.now()) {
  if (!env.GITHUB_APP_WEBHOOK_SECRET || !githubConfigured()) return 0
  const attempts = await hookDeliveries(new Date(now - REDELIVER_WITHIN_MS))
  const byGuid = Map.groupBy(attempts, (a) => a.guid)
  const failed = [...byGuid.entries()].filter(
    ([, tries]) =>
      tries.every((t) => t.status_code < 200 || t.status_code >= 300) &&
      tries.every((t) => now - Date.parse(t.delivered_at) > REDELIVER_AFTER_MS),
  )
  if (!failed.length) return 0
  const kept = new Set(
    (
      await prisma.inboundEvent.findMany({
        where: { source: 'github', externalId: { in: failed.map(([guid]) => guid) } },
        select: { externalId: true },
      })
    ).map((e) => e.externalId),
  )
  let asked = 0
  for (const [guid, tries] of failed) {
    if (kept.has(guid) || asked >= REDELIVER_MAX) continue
    const latest = tries.reduce((a, b) =>
      Date.parse(a.delivered_at) > Date.parse(b.delivered_at) ? a : b,
    )
    await redeliverHook(latest.id).catch((error) =>
      console.warn(`github delivery ${guid}: not asked again`, error),
    )
    asked++
  }
  if (asked) noteFailure('github-webhook', `${asked} GitHub deliveries had failed: asked for again`)
  return asked
}

export const githubWebhook = new Hono().post('/', async (c) => {
  if (!env.GITHUB_APP_WEBHOOK_SECRET) return c.json({ error: 'Not configured' }, 404)
  const body = await c.req.text()
  if (!signed(body, c.req.header('x-hub-signature-256')))
    return c.json({ error: 'Bad signature' }, 401)
  const event = c.req.header('x-github-event')
  const delivery = c.req.header('x-github-delivery')
  const payload = JSON.parse(body) as Payload
  if (!payload.installation?.id || !event || !delivery) return c.body(null, 204)
  // Kept, then processed from its row; GitHub waits ten seconds at most. Sent again (asked for
  // again after a failure), it is recognised and processed once.
  const { duplicate } = await keepInbound({
    source: 'github',
    externalId: delivery,
    type: event,
    payload,
  })
  return c.body(null, duplicate ? 200 : 202)
})
