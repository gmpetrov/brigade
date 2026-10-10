// Google Calendar: a push channel per watched calendar (events.watch), renewed
// before it expires. A push only says "something changed": the calendar's sync
// token says what.
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { env } from '../config.js'
import { authorisedFetch } from '../connector-calls.js'
import { isOwnChange, type Event } from '../connectors/google-calendar.js'
import { json, type ConnectorContext } from '../connectors/types.js'
import { prisma, scoped, type Scope } from '../db.js'
import { dispatch } from '../triggers.js'
import { deleteSecret, openSecret, sealSecret } from '../vault.js'
import { reachable, serially, SubscribeError, type Target } from './common.js'

const API = 'https://www.googleapis.com/calendar/v3'
const TTL_S = 7 * 24 * 3600
/** Renew a channel once it has less than this left. */
const RENEW_MS = 24 * 3600_000
/** After a failed read, the changes wait this long before the next try. */
const RETRY_MS = 5 * 60_000
/** Within this, an event's first revision: it was just created. */
const NEW_MS = 5_000

type Page = { items?: Event[]; nextPageToken?: string; nextSyncToken?: string }
type ChannelToken = { token: string }

const eventsUrl = (calendarId: string, params: Record<string, string>) =>
  `${API}/calendars/${encodeURIComponent(calendarId)}/events?${new URLSearchParams(params)}`

/** Page through to a sync token, ignoring what is there now. */
async function freshSyncToken(fetch: ConnectorContext['fetch'], calendarId: string) {
  let pageToken: string | undefined
  for (;;) {
    const page = await json<Page>(
      await fetch(
        eventsUrl(calendarId, {
          maxResults: '2500',
          fields: 'nextPageToken,nextSyncToken',
          ...(pageToken ? { pageToken } : {}),
        }),
      ),
    )
    if (page.nextSyncToken) return page.nextSyncToken
    pageToken = page.nextPageToken
    if (!pageToken) throw new Error('Google Calendar returned no sync token')
  }
}

async function openChannel(fetch: ConnectorContext['fetch'], calendarId: string, token: string) {
  const id = randomUUID()
  const channel = await json<{ resourceId: string; expiration: string }>(
    await fetch(`${API}/calendars/${encodeURIComponent(calendarId)}/events/watch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id,
        type: 'web_hook',
        address: `${env.API_URL}/events/google-calendar`,
        token,
        params: { ttl: String(TTL_S) },
      }),
    }),
  )
  return { id, resourceId: channel.resourceId, expiresAt: new Date(Number(channel.expiration)) }
}

const stopChannel = (fetch: ConnectorContext['fetch'], id: string, resourceId: string) =>
  fetch(`${API}/channels/stop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, resourceId }),
  }).catch(() => undefined)

export async function syncCalendar(target: Target) {
  const { db, scope, connection } = target
  const wanted = new Set(
    target.triggers.map(
      (t) => (t.options as { calendarId?: string } | null)?.calendarId?.trim() || 'primary',
    ),
  )
  const existing = await db.subscription.findMany({ where: { connectionId: connection.id } })
  const fetch = await authorisedFetch(db, scope, connection)

  for (const sub of existing.filter((s) => !wanted.has(s.resource))) {
    if (sub.externalId && sub.externalResourceId)
      await stopChannel(fetch, sub.externalId, sub.externalResourceId)
    await db.subscription.deleteMany({ where: { id: sub.id } })
    if (sub.secretId) await deleteSecret(db, sub.secretId)
  }
  if (wanted.size === 0) return
  if (!reachable())
    throw new SubscribeError(
      `Google Calendar can only send changes to a public HTTPS address, and this server is ${env.API_URL}`,
    )

  for (const calendarId of wanted) {
    const sub = existing.find((s) => s.resource === calendarId)
    if (sub?.expiresAt && sub.expiresAt.getTime() - Date.now() > RENEW_MS) continue
    const token = randomBytes(24).toString('base64url')
    let channel: Awaited<ReturnType<typeof openChannel>>
    let cursor = sub?.cursor ?? null
    try {
      cursor ??= await freshSyncToken(fetch, calendarId)
      channel = await openChannel(fetch, calendarId, token)
    } catch (error) {
      throw new SubscribeError(
        `Google Calendar would not watch "${calendarId}" (${error instanceof Error ? error.message : error})`,
      )
    }
    const secretId = await sealSecret(db, scope, { token } satisfies ChannelToken)
    const data = {
      mode: 'push' as const,
      externalId: channel.id,
      externalResourceId: channel.resourceId,
      secretId,
      expiresAt: channel.expiresAt,
      cursor,
      error: null,
    }
    if (sub) {
      await db.subscription.updateMany({ where: { id: sub.id }, data })
      if (sub.externalId && sub.externalResourceId)
        await stopChannel(fetch, sub.externalId, sub.externalResourceId)
      if (sub.secretId) await deleteSecret(db, sub.secretId)
    } else {
      await db.subscription.create({
        data: { connectionId: connection.id, resource: calendarId, events: [], ...data } as never,
      })
    }
  }
}

/** The trigger event types one changed event stands for, with ids that dedupe them. */
function changesOf(e: Event): { id: string; type: string }[] {
  if (e.status === 'cancelled') return [{ id: `${e.id}@${e.updated}`, type: 'cancelled' }]
  const created = e.created && e.updated && Date.parse(e.updated) - Date.parse(e.created) < NEW_MS
  const invited =
    !e.organizer?.self && e.attendees?.some((a) => a.self && a.responseStatus === 'needsAction')
  return [
    created
      ? { id: `${e.id}:created`, type: 'created' }
      : { id: `${e.id}@${e.updated}`, type: 'updated' },
    // Once per event, however often it changes before the answer.
    ...(invited ? [{ id: `${e.id}:invited`, type: 'invited' }] : []),
  ]
}

export const retryAt = new Map<string, number>()

/** Read the calendar's changes since the sync token and offer each to the triggers. */
export const readCalendar = (subscriptionId: string) =>
  serially(`calendar:${subscriptionId}`, async () => {
    const sub = await prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: { connection: true },
    })
    if (!sub?.cursor || sub.connection.status !== 'active') return
    const scope: Scope = { organizationId: sub.organizationId, workspaceId: sub.workspaceId }
    const db = scoped(scope)
    const fetch = await authorisedFetch(db, scope, sub.connection)
    const save = (data: { cursor: string; error?: string | null }) =>
      db.subscription.updateMany({ where: { id: sub.id }, data })

    let pageToken: string | undefined
    try {
      for (;;) {
        const response = await fetch(
          eventsUrl(sub.resource, {
            syncToken: sub.cursor,
            maxResults: '250',
            ...(pageToken ? { pageToken } : {}),
          }),
        )
        // The token expired: start again from now.
        if (response.status === 410)
          return save({ cursor: await freshSyncToken(fetch, sub.resource), error: null })
        const page = await json<Page>(response)
        for (const event of page.items ?? []) {
          if (isOwnChange(event)) continue
          for (const change of changesOf(event)) {
            const { failed } = await dispatch(sub.connection, { ...change, payload: event })
            // The token moves only per page: the whole page is offered again, deduped.
            if (failed) {
              retryAt.set(sub.id, Date.now() + RETRY_MS)
              return
            }
          }
        }
        if (page.nextSyncToken) {
          retryAt.delete(sub.id)
          return save({ cursor: page.nextSyncToken, error: null })
        }
        pageToken = page.nextPageToken
        if (!pageToken) return
      }
    } catch (error) {
      retryAt.set(sub.id, Date.now() + RETRY_MS)
      await db.subscription.updateMany({
        where: { id: sub.id },
        data: { error: error instanceof Error ? error.message : String(error) },
      })
      throw error
    }
  })

/** A channel's notification: check its token, then read the changes. */
export async function calendarChanged(headers: {
  channelId?: string
  token?: string
  state?: string
}) {
  if (!headers.channelId || !headers.token) return false
  const sub = await prisma.subscription.findFirst({
    where: { externalId: headers.channelId, connection: { kind: 'google_calendar' } },
  })
  if (!sub?.secretId) return false
  const scope: Scope = { organizationId: sub.organizationId, workspaceId: sub.workspaceId }
  const { token } = await openSecret<ChannelToken>(scoped(scope), scope, sub.secretId)
  const given = Buffer.from(headers.token)
  const expected = Buffer.from(token)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false
  // "sync" only confirms a new channel.
  if (headers.state !== 'sync')
    void readCalendar(sub.id).catch((error) =>
      console.error(`calendar ${sub.id}:`, error instanceof Error ? error.message : error),
    )
  return true
}
