// Subscriptions: how Brigade hears about each connection's events. Synced with
// the connection's triggers whenever they change, and for Gmail with the replies
// threads await (src/replies.ts); a minute's tick renews what expires, retries
// failed reads, drops an inbox nothing listens to any more and, for Gmail without
// Pub/Sub, polls.
import { env } from '../config.js'
import type { ConnectorKind } from '../connectors/types.js'
import { prisma, scoped, type Scope, type ScopedDb } from '../db.js'
import { SubscribeError, type Target } from './common.js'
import { gmailPush, readInbox, retryAt as gmailRetries, syncGmail } from './gmail.js'
import { readCalendar, retryAt as calendarRetries, syncCalendar } from './google-calendar.js'
import { syncStripe } from './stripe.js'
import { inInbox } from '../mail/gmail-inbox.js'

export { SubscribeError }

const TICK_MS = 60_000

/** Why a kind of trigger cannot be set up on this server, if it cannot. */
export function unavailable(kind: ConnectorKind): string | null {
  if (kind === 'email' && (!env.RESEND_API_KEY || !env.RESEND_WEBHOOK_SECRET))
    return 'The Email App needs Resend configured on this Brigade server (RESEND_API_KEY and RESEND_WEBHOOK_SECRET)'
  if (kind === 'github' && !env.GITHUB_APP_WEBHOOK_SECRET)
    return "GitHub triggers need the GitHub App's webhook (GITHUB_APP_WEBHOOK_SECRET) configured on this Brigade server"
  return null
}

/** How events reach Brigade for a kind of connection, for the dashboard. */
export const delivery = (kind: ConnectorKind) =>
  kind === 'gmail' ? (gmailPush() ? 'push' : 'poll') : 'push'

/** Whether threads wait on a reply in this connection's mailbox. */
const awaitingReplies = async (db: ScopedDb, connectionId: string) =>
  (await db.replyWatch.count({ where: { connectionId, until: { gt: new Date() } } })) > 0

/**
 * Make the vendor-side subscriptions match the connection's triggers and awaited
 * replies: register, update or remove them. Throws SubscribeError with a reason a
 * person can act on.
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
  const target: Target = {
    db,
    scope,
    connection: connection as Target['connection'],
    triggers,
    awaitingReplies:
      !options.removing &&
      connection.kind === 'gmail' &&
      // A shared account is read for the Inbox too (src/mail/gmail-inbox.ts).
      (inInbox(connection) || (await awaitingReplies(db, connectionId))),
  }
  if (connection.kind === 'stripe') await syncStripe(target)
  else if (connection.kind === 'gmail') await syncGmail(target)
  else if (connection.kind === 'google_calendar') await syncCalendar(target)
  // GitHub: the GitHub App's one webhook. Custom apps: each trigger's own URL.
}

/** Whether a Gmail connection's inbox still has a trigger or an awaited reply to read for. */
async function listened(scope: Scope, connectionId: string) {
  const db = scoped(scope)
  const connection = await db.connection.findFirst({
    where: { id: connectionId },
    select: { kind: true, reach: true, inbox: true },
  })
  return (
    (connection ? inInbox(connection) : false) ||
    (await db.trigger.count({ where: { connectionId, teammate: { archivedAt: null } } })) > 0 ||
    (await awaitingReplies(db, connectionId))
  )
}

async function tick() {
  // A Gmail account put in the Inbox with nothing reading it yet: subscribed, so its mail
  // reaches the Inbox.
  const unread = await prisma.connection.findMany({
    where: {
      kind: 'gmail',
      status: 'active',
      reach: 'workspace',
      inbox: true,
      subscriptions: { none: {} },
    },
    select: { id: true, organizationId: true, workspaceId: true },
    take: 20,
  })
  for (const c of unread)
    await syncConnection(
      { organizationId: c.organizationId, workspaceId: c.workspaceId },
      c.id,
    ).catch((error) => console.warn(`inbox: ${c.id} not subscribed`, error))
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
      // Expiring watches and channels, Gmail switching between push and poll, and an
      // inbox read only for replies no thread awaits any more.
      const stale =
        (sub.mode === 'push' && sub.expiresAt && sub.expiresAt.getTime() < soon) ||
        (kind === 'gmail' && sub.mode !== delivery('gmail')) ||
        (kind === 'gmail' && !(await listened(scope, sub.connectionId)))
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
  setTimeout(() => void run(), 10_000)
  setInterval(() => void run(), TICK_MS)
}
