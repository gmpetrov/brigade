// Subscriptions: how Brigade hears about each connection's events. Synced with
// the connection's triggers whenever they change; a minute's tick renews what
// expires, retries failed reads and, for Gmail without Pub/Sub, polls.
import { env } from '../config.js'
import type { ConnectorKind } from '../connectors/types.js'
import { prisma, scoped, type Scope } from '../db.js'
import { SubscribeError, type Target } from './common.js'
import { gmailPush, readInbox, retryAt as gmailRetries, syncGmail } from './gmail.js'
import { readCalendar, retryAt as calendarRetries, syncCalendar } from './google-calendar.js'
import { syncStripe } from './stripe.js'

export { SubscribeError }

const TICK_MS = 60_000

/** Why a kind of trigger cannot be set up on this server, if it cannot. */
export function unavailable(kind: ConnectorKind): string | null {
  if (kind === 'github' && !env.GITHUB_APP_WEBHOOK_SECRET)
    return "GitHub triggers need the GitHub App's webhook (GITHUB_APP_WEBHOOK_SECRET) configured on this Brigade server"
  return null
}

/** How events reach Brigade for a kind of connection, for the dashboard. */
export const delivery = (kind: ConnectorKind) =>
  kind === 'gmail' ? (gmailPush() ? 'push' : 'poll') : 'push'

/**
 * Make the vendor-side subscriptions match the connection's triggers: register,
 * update or remove them. Throws SubscribeError with a reason a person can act on.
 */
export async function syncConnection(
  scope: Scope,
  connectionId: string,
  options: { removing?: boolean } = {},
) {
  const db = scoped(scope)
  const connection = await db.connection.findFirst({ where: { id: connectionId } })
  if (!connection) return
  const triggers = options.removing
    ? []
    : await db.trigger.findMany({
        where: { connectionId, teammate: { archivedAt: null } },
        select: { event: true, options: true },
      })
  const target: Target = { db, scope, connection: connection as Target['connection'], triggers }
  if (connection.kind === 'stripe') await syncStripe(target)
  else if (connection.kind === 'gmail') await syncGmail(target)
  else if (connection.kind === 'google_calendar') await syncCalendar(target)
  // GitHub: the GitHub App's one webhook. Custom apps: each trigger's own URL.
}

async function tick() {
  const subs = await prisma.subscription.findMany({
    where: { connection: { status: 'active' } },
    include: { connection: { select: { kind: true } } },
  })
  const soon = Date.now() + 25 * 3600_000
  const synced = new Set<string>()
  for (const sub of subs) {
    const scope: Scope = { organizationId: sub.organizationId, workspaceId: sub.workspaceId }
    const kind = sub.connection.kind
    try {
      // Expiring watches and channels, and Gmail switching between push and poll.
      const stale =
        (sub.mode === 'push' && sub.expiresAt && sub.expiresAt.getTime() < soon) ||
        (kind === 'gmail' && sub.mode !== delivery('gmail'))
      if (stale && !synced.has(sub.connectionId)) {
        synced.add(sub.connectionId)
        await syncConnection(scope, sub.connectionId)
      }
      if (kind === 'gmail') {
        const due = (gmailRetries.get(sub.id) ?? 0) <= Date.now()
        if (sub.mode === 'poll' ? due : gmailRetries.has(sub.id) && due) await readInbox(sub.id)
      }
      if (kind === 'google_calendar') {
        const due = calendarRetries.get(sub.id)
        if (due !== undefined && due <= Date.now()) await readCalendar(sub.id)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`subscription ${sub.id}:`, message)
      await prisma.subscription.updateMany({ where: { id: sub.id }, data: { error: message } })
    }
  }
}

let ticking = false
export function watchSubscriptions() {
  const run = async () => {
    if (ticking) return
    ticking = true
    try {
      await tick()
    } catch (error) {
      console.error('subscriptions tick:', error)
    } finally {
      ticking = false
    }
  }
  setTimeout(() => void run(), 10_000).unref()
  setInterval(() => void run(), TICK_MS).unref()
}
