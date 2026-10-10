// Gmail: with Pub/Sub configured, Gmail tells Brigade when an inbox changes
// (users.watch, renewed daily; Gmail drops it after seven days). Without it,
// Brigade checks every minute. Either way the mailbox's history says what is
// new since the last read.
import { createPublicKey, verify, type JsonWebKey } from 'node:crypto'
import { env } from '../config.js'
import { authorisedFetch } from '../connector-calls.js'
import { API, full, type Message, type ReceivedEmail } from '../connectors/gmail.js'
import { json } from '../connectors/types.js'
import { prisma, scoped, type Scope } from '../db.js'
import { dispatch } from '../triggers.js'
import { reachable, serially, type Target } from './common.js'

const RESOURCE = 'inbox'
/** Renew a watch once it has less than this left (Google suggests renewing daily). */
const RENEW_MS = 6 * 24 * 3600_000
/** At most this many emails per read; the rest wait for the next one. */
const PER_READ = 20

export const gmailPush = () =>
  Boolean(env.GMAIL_PUBSUB_TOPIC && env.GMAIL_PUBSUB_PUSH_ACCOUNT && reachable())

type History = {
  history?: { id: string; messagesAdded?: { message: { id: string; labelIds?: string[] } }[] }[]
  historyId: string
  nextPageToken?: string
}

export async function syncGmail(target: Target) {
  const { db, scope, connection } = target
  const existing = await db.subscription.findFirst({
    where: { connectionId: connection.id, resource: RESOURCE },
  })
  const wanted = target.triggers.length > 0
  const fetch = await authorisedFetch(db, scope, connection)

  if (!wanted) {
    if (!existing) return
    if (existing.mode === 'push')
      await fetch(`${API}/stop`, { method: 'POST' }).catch(() => undefined)
    await db.subscription.deleteMany({ where: { id: existing.id } })
    return
  }

  const mode = gmailPush() ? 'push' : 'poll'
  const row =
    existing ??
    (await db.subscription.create({
      data: {
        connectionId: connection.id,
        resource: RESOURCE,
        mode,
        events: ['email'],
        // Only mail that arrives from now on.
        cursor: (await json<{ historyId: string }>(await fetch(`${API}/profile`))).historyId,
      } as never,
    }))

  if (mode === 'poll') {
    if (row.mode === 'push') await fetch(`${API}/stop`, { method: 'POST' }).catch(() => undefined)
    await db.subscription.updateMany({
      where: { id: row.id },
      data: { mode, expiresAt: null, error: null },
    })
    return
  }
  const fresh =
    row.mode === 'push' && row.expiresAt && row.expiresAt.getTime() - Date.now() > RENEW_MS
  if (fresh) return
  const watch = await json<{ historyId: string; expiration: string }>(
    await fetch(`${API}/watch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        topicName: env.GMAIL_PUBSUB_TOPIC,
        labelIds: ['INBOX'],
        labelFilterBehavior: 'INCLUDE',
      }),
    }),
  )
  await db.subscription.updateMany({
    where: { id: row.id },
    data: {
      mode,
      expiresAt: new Date(Number(watch.expiration)),
      cursor: row.cursor ?? watch.historyId,
      error: null,
    },
  })
}

/** After a failed read, the mail waits this long before the next try. */
const RETRY_MS = 5 * 60_000
export const retryAt = new Map<string, number>()

/**
 * Read what is new in the inbox since the cursor and offer each email to the
 * connection's triggers. The cursor moves past an email only once every
 * thread it should start has started.
 */
export const readInbox = (subscriptionId: string) =>
  serially(`gmail:${subscriptionId}`, async () => {
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
    const now = async () =>
      (await json<{ historyId: string }>(await fetch(`${API}/profile`))).historyId

    const start = sub.cursor
    let cursor = start
    let read = 0
    let pageToken: string | undefined
    try {
      do {
        const params = new URLSearchParams({
          startHistoryId: start,
          historyTypes: 'messageAdded',
          labelId: 'INBOX',
          maxResults: '100',
          ...(pageToken ? { pageToken } : {}),
        })
        const response = await fetch(`${API}/history?${params}`)
        // Gmail keeps about a week of history. Past that, start again from now.
        if (response.status === 404) return save({ cursor: await now(), error: null })
        const page = await json<History>(response)
        for (const record of page.history ?? []) {
          for (const { message } of record.messagesAdded ?? []) {
            // The mailbox's own mail, e.g. a teammate's reply to itself, starts nothing.
            if (message.labelIds?.some((l) => l === 'SENT' || l === 'DRAFT')) continue
            if (read >= PER_READ) {
              await save({ cursor })
              // Pushes come only for new changes: read the rest now.
              if (sub.mode === 'push') setTimeout(() => void readInbox(sub.id), 1000).unref()
              return
            }
            read++
            const got = await fetch(`${API}/messages/${encodeURIComponent(message.id)}?format=full`)
            if (got.status === 404) continue // deleted since
            const email = await json<Message>(got)
            const payload: ReceivedEmail = {
              ...full(email),
              rfcMessageId: email.payload?.headers?.find(
                (h) => h.name.toLowerCase() === 'message-id',
              )?.value,
            }
            const { failed } = await dispatch(sub.connection, {
              id: email.id,
              type: 'email',
              payload,
            })
            if (failed) {
              retryAt.set(sub.id, Date.now() + RETRY_MS)
              return save({ cursor })
            }
          }
          cursor = record.id
        }
        pageToken = page.nextPageToken
        if (!pageToken) cursor = page.historyId
      } while (pageToken)
      retryAt.delete(sub.id)
      await save({ cursor, error: null })
    } catch (error) {
      retryAt.set(sub.id, Date.now() + RETRY_MS)
      await save({ cursor, error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  })

// ---------------------------------------------------------------------------
// Pub/Sub push: a Google-signed token (OIDC) on each request.
// ---------------------------------------------------------------------------

type Jwk = JsonWebKey & { kid: string }
let certs: { keys: Jwk[]; until: number } | undefined

async function googleKey(kid: string) {
  if (!certs || certs.until < Date.now() || !certs.keys.some((k) => k.kid === kid)) {
    const response = await fetch('https://www.googleapis.com/oauth2/v3/certs')
    const body = (await response.json()) as { keys: Jwk[] }
    certs = { keys: body.keys, until: Date.now() + 3600_000 }
  }
  const jwk = certs.keys.find((k) => k.kid === kid)
  return jwk ? createPublicKey({ key: jwk, format: 'jwk' }) : null
}

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))

/** Whether the request comes from the configured Pub/Sub push subscription. */
export async function fromPubSub(authorization: string | undefined) {
  const token = authorization?.match(/^Bearer (.+)$/)?.[1]
  if (!token || !env.GMAIL_PUBSUB_PUSH_ACCOUNT) return false
  const [head, body, signature] = token.split('.')
  if (!head || !body || !signature) return false
  try {
    const header = decode(head) as { alg?: string; kid?: string }
    if (header.alg !== 'RS256' || !header.kid) return false
    const key = await googleKey(header.kid)
    if (!key) return false
    if (
      !verify(
        'RSA-SHA256',
        Buffer.from(`${head}.${body}`),
        key,
        Buffer.from(signature, 'base64url'),
      )
    )
      return false
    const claims = decode(body) as {
      iss?: string
      aud?: string
      exp?: number
      email?: string
      email_verified?: boolean
    }
    return (
      (claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com') &&
      claims.aud === `${env.API_URL}/events/gmail` &&
      (claims.exp ?? 0) * 1000 > Date.now() &&
      claims.email === env.GMAIL_PUBSUB_PUSH_ACCOUNT &&
      claims.email_verified === true
    )
  } catch {
    return false
  }
}

/** A Pub/Sub push names the mailbox that changed: read each connection on it. */
export async function inboxChanged(body: unknown) {
  const data = (body as { message?: { data?: string } }).message?.data
  if (!data) return
  const { emailAddress } = JSON.parse(Buffer.from(data, 'base64').toString('utf8')) as {
    emailAddress?: string
  }
  if (!emailAddress) return
  const subs = await prisma.subscription.findMany({
    where: {
      resource: RESOURCE,
      mode: 'push',
      connection: {
        kind: 'gmail',
        status: 'active',
        externalAccount: { equals: emailAddress, mode: 'insensitive' },
      },
    },
    select: { id: true },
  })
  for (const sub of subs)
    void readInbox(sub.id).catch((error) =>
      console.error(`gmail ${sub.id}:`, error instanceof Error ? error.message : error),
    )
}
