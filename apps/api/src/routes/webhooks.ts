// Webhooks and triggers. An http webhook is a Brigade URL a third-party app
// posts to; a gmail trigger watches a Gmail connection's inbox (see triggers.ts).
// Each event opens a new thread for the teammate, with the event as its first message.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { CreateWebhook, SetWebhookSecret } from '@brigade/contracts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { audit } from '../audit.js'
import { env } from '../config.js'
import { triggerSource } from '../connectors/index.js'
import { scoped, type Scope, type ScopedDb } from '../db.js'
import { parseBody, requireRole, requireUser, requireWorkspace, type AppEnv } from '../scope.js'
import { deleteSecret, openSecret, replaceSecret, sealSecret } from '../vault.js'
import { deliver, fenced, findWebhook } from '../triggers.js'

const MAX_BODY = 1024 * 1024
/** Stripe's default tolerance for a signature's timestamp. */
const STRIPE_TOLERANCE_S = 300

type SigningSecret = { secret: string }

const urlOf = (pathToken: string) => `${env.API_URL}/hooks/${pathToken}`

/** Delete webhooks and their signing secrets, e.g. when their connection is removed. */
export async function deleteWebhooks(
  db: ScopedDb,
  where: { connectionId?: string; teammateId?: string; id?: string },
) {
  const rows = await db.webhook.findMany({ where })
  for (const row of rows) {
    await db.webhook.deleteMany({ where: { id: row.id } })
    if (row.verificationSecretId) await deleteSecret(db, row.verificationSecretId)
  }
  return rows
}

export const webhooks = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)

  .get('/', async (c) => {
    const rows = await c.var.db.webhook.findMany({
      include: { teammate: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    })
    return c.json(
      rows.map(({ verificationSecretId, pathToken, cursor: _cursor, ...row }) => ({
        ...row,
        url: pathToken ? urlOf(pathToken) : null,
        hasSecret: Boolean(verificationSecretId),
      })),
    )
  })

  /** Admins only. For hmac, the generated signing secret is shown once, in this response. */
  .post('/', async (c) => {
    const { scope, db } = c.var
    requireRole(scope, 'owner', 'admin')
    const input = await parseBody(c.req.raw, CreateWebhook)
    const [connection, teammate] = await Promise.all([
      db.connection.findFirst({ where: { id: input.connectionId, status: { not: 'removed' } } }),
      db.teammate.findFirst({ where: { id: input.teammateId, archivedAt: null } }),
    ])
    if (!connection || !teammate)
      throw new HTTPException(404, { message: 'Connection or teammate not found' })
    const source = triggerSource[connection.kind]
    if (!source)
      throw new HTTPException(400, { message: `${connection.label} cannot start threads` })

    if (source === 'gmail') {
      const row = await db.webhook.create({
        data: {
          connectionId: connection.id,
          teammateId: teammate.id,
          label: input.label,
          source,
          verification: 'none',
          filter: input.filter || null,
          createdByMemberId: scope.memberId,
        } as never,
      })
      await audit({
        ...scope,
        actor: { type: 'member', id: scope.memberId },
        action: 'webhook.created',
        target: { type: 'webhook', id: row.id },
        data: { connectionId: connection.id, teammateId: teammate.id, source, filter: row.filter },
      })
      return c.json({ id: row.id, url: null }, 201)
    }

    if (!input.verification)
      throw new HTTPException(400, { message: 'Choose how the sender is verified' })
    let secret: string | null = null
    if (input.verification === 'stripe') {
      if (connection.kind !== 'stripe')
        throw new HTTPException(400, { message: 'Stripe signatures are for Stripe connections' })
      // Stripe shows the secret only once the URL is added there; it can be set afterwards.
      if (input.signingSecret && !input.signingSecret.startsWith('whsec_'))
        throw new HTTPException(400, { message: "Stripe's signing secrets start with whsec_" })
      secret = input.signingSecret || null
    } else if (input.verification === 'hmac') {
      secret = `bwh_${randomBytes(32).toString('base64url')}`
    }
    const pathToken = randomBytes(24).toString('base64url')
    const verificationSecretId = secret ? await sealSecret(db, scope, { secret }) : null
    const row = await db.webhook.create({
      data: {
        connectionId: connection.id,
        teammateId: teammate.id,
        label: input.label,
        source,
        verification: input.verification,
        pathToken,
        verificationSecretId,
        createdByMemberId: scope.memberId,
      } as never,
    })
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'webhook.created',
      target: { type: 'webhook', id: row.id },
      data: {
        connectionId: connection.id,
        teammateId: teammate.id,
        source,
        verification: input.verification,
      },
    })
    return c.json(
      {
        id: row.id,
        url: urlOf(pathToken),
        ...(input.verification === 'hmac' ? { signingSecret: secret } : {}),
      },
      201,
    )
  })

  /** Set a Stripe endpoint's signing secret, once Stripe shows it. */
  .patch('/:id', async (c) => {
    const { scope, db } = c.var
    requireRole(scope, 'owner', 'admin')
    const { signingSecret } = await parseBody(c.req.raw, SetWebhookSecret)
    const row = await db.webhook.findFirst({ where: { id: c.req.param('id') } })
    if (!row) throw new HTTPException(404, { message: 'Webhook not found' })
    if (row.verification !== 'stripe')
      throw new HTTPException(409, { message: 'Only Stripe webhooks take a pasted secret' })
    if (row.verificationSecretId)
      await replaceSecret(db, scope, row.verificationSecretId, { secret: signingSecret })
    else
      await db.webhook.updateMany({
        where: { id: row.id },
        data: { verificationSecretId: await sealSecret(db, scope, { secret: signingSecret }) },
      })
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'webhook.secret_set',
      target: { type: 'webhook', id: row.id },
    })
    return c.json({ ok: true })
  })

  .delete('/:id', async (c) => {
    const { scope, db } = c.var
    requireRole(scope, 'owner', 'admin')
    const [row] = await deleteWebhooks(db, { id: c.req.param('id') })
    if (!row) throw new HTTPException(404, { message: 'Webhook not found' })
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'webhook.deleted',
      target: { type: 'webhook', id: row.id },
    })
    return c.body(null, 204)
  })

const equal = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}
const hmacHex = (secret: string, data: string) =>
  createHmac('sha256', secret).update(data).digest('hex')

/** Stripe-Signature: t=<unix>,v1=<hex HMAC of "t.body">, possibly several v1. */
function verifyStripe(header: string | undefined, body: string, secret: string) {
  if (!header) return false
  const parts = header.split(',').map((p) => p.split('=') as [string, string])
  const t = Number(parts.find(([k]) => k === 't')?.[1])
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > STRIPE_TOLERANCE_S) return false
  const expected = hmacHex(secret, `${t}.${body}`)
  return parts.some(([k, v]) => k === 'v1' && equal(v, expected))
}

/** X-Brigade-Signature (or GitHub-style X-Hub-Signature-256): sha256=<hex HMAC of the body>. */
function verifyHmac(header: string | undefined, body: string, secret: string) {
  return Boolean(header) && equal(header!, `sha256=${hmacHex(secret, body)}`)
}

/** The public endpoint third-party apps post to. No session: the URL and signature identify it. */
export const inboundWebhooks = new Hono().post('/:token', async (c) => {
  const webhook = await findWebhook(c.req.param('token'))
  if (!webhook) return c.json({ error: 'Unknown webhook' }, 404)
  const scope: Scope = { organizationId: webhook.organizationId, workspaceId: webhook.workspaceId }
  const db = scoped(scope)

  const body = await c.req.text()
  if (body.length > MAX_BODY) return c.json({ error: 'Payload too large' }, 413)
  if (webhook.verification !== 'none') {
    if (!webhook.verificationSecretId)
      return c.json({ error: 'This webhook has no signing secret yet' }, 401)
    const { secret } = await openSecret<SigningSecret>(db, scope, webhook.verificationSecretId)
    const ok =
      webhook.verification === 'stripe'
        ? verifyStripe(c.req.header('stripe-signature'), body, secret)
        : verifyHmac(
            c.req.header('x-brigade-signature') ?? c.req.header('x-hub-signature-256'),
            body,
            secret,
          )
    if (!ok) return c.json({ error: 'Bad signature' }, 401)
  }
  if (webhook.teammate.archivedAt || webhook.connection.status === 'removed')
    return c.json({ error: 'This webhook is no longer active' }, 410)

  let payload: unknown = body
  try {
    payload = JSON.parse(body)
  } catch {
    // Not JSON: passed on as text.
  }
  const fields = typeof payload === 'object' && payload ? (payload as Record<string, unknown>) : {}
  // Stripe names the event in the body; GitHub in a header, with the action in the body.
  const githubEvent = c.req.header('x-github-event')
  const eventType =
    typeof fields.type === 'string'
      ? fields.type
      : githubEvent
        ? `${githubEvent}${typeof fields.action === 'string' ? `.${fields.action}` : ''}`
        : 'event'
  // Senders retry; one thread per event id.
  const eventId =
    (typeof fields.id === 'string' && fields.id) ||
    c.req.header('x-github-delivery') ||
    c.req.header('x-request-id') ||
    null

  const text = [
    `Inbound webhook "${webhook.label}" from ${webhook.connection.externalAccount ?? webhook.connection.label}, event ${eventType}, received ${new Date().toISOString()}. Payload:`,
    typeof payload === 'string'
      ? fenced(payload)
      : fenced(JSON.stringify(payload, null, 2), 'json'),
  ].join('\n')

  const delivery = await deliver(webhook, {
    eventId,
    eventType,
    title: `${webhook.label}: ${eventType}`,
    text,
  })
  // The sender retries.
  if ('error' in delivery) return c.json({ error: delivery.error }, 503, { 'retry-after': '300' })
  if ('duplicate' in delivery) return c.json({ ok: true, duplicate: true })
  return c.json({ ok: true, threadId: delivery.threadId, paused: delivery.paused }, 202)
})
