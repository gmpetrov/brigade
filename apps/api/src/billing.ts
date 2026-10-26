// Billing: one paid plan, Cloud, subscribed per workspace, which gives the workspace its
// cloud computer. Brigade itself stays free on members' own machines. Stripe holds the
// subscription; BillingSubscription rows follow it. Without STRIPE_SECRET_KEY billing is off
// and every workspace has the cloud computer, as on a self-hosted Brigade.
//
// One rule keeps the rows right: they only ever take Stripe's current state, read under a
// lock on the workspace, never what an event says. Events come late, twice, out of order
// or overlapping; each one only says "look again". A read that fails changes nothing, and
// Stripe is asked to send the event again. The rows are written through the lock's own
// transaction: a run that outlived its lock (a slow Stripe) writes nothing.
import { HTTPException } from 'hono/http-exception'
import Stripe from 'stripe'
import { env } from './config.js'
import { prisma, type Prisma } from './db.js'
import { noteFailure } from './ops/failures.js'

export const billingEnabled = () => !!env.STRIPE_SECRET_KEY

export const stripeClient = env.STRIPE_SECRET_KEY
  ? new Stripe(env.STRIPE_SECRET_KEY, {
      // Workers have no Node http: fetch everywhere.
      httpClient: Stripe.createFetchHttpClient(),
      // Well within a lock (billingTiming): a run that still outlives it writes nothing.
      timeout: 15_000,
      maxNetworkRetries: 1,
      appInfo: { name: 'Brigade', url: 'https://www.brigade.lol' },
    })
  : null

/** How long a run may hold a workspace's billing lock. Tests shorten it. */
export const billingTiming = { lockMs: 60_000 }

/**
 * The Cloud plan: $99 a month, €99 in the euro zone. One Stripe price with a EUR currency
 * option, found by its lookup key, so test and live accounts need no price ids here:
 * Checkout shows the customer's currency. Add-ons (an email address at $10 a month) will
 * be more items on the same subscription.
 */
export const CLOUD_PLAN = { name: 'cloud', lookupKey: 'brigade_cloud_monthly' }

/**
 * The statuses that keep the cloud computer. past_due too: Stripe retries the payment for a
 * while, and only once it gives up (unpaid or canceled) does the workspace lose it.
 */
const ENTITLED = ['active', 'trialing', 'past_due']

export const entitles = (status: string) => ENTITLED.includes(status)

/** Statuses of a subscription that is over: a new one may be made. */
const OVER = ['canceled', 'incomplete_expired']

type Db = Prisma.TransactionClient | typeof prisma

/** The workspace's plan that counts: the one that entitles it, else the latest. */
export async function workspacePlan(workspaceId: string, db: Db = prisma) {
  const rows = await db.billingSubscription.findMany({
    where: { workspaceId, plan: CLOUD_PLAN.name },
  })
  return pickPlan(rows)
}

/** Of a workspace's subscription rows, the one that entitles it, else the most recent. */
export function pickPlan<T extends { status: string; periodStart: Date | null }>(rows: T[]) {
  const entitled = rows.find((row) => entitles(row.status))
  if (entitled) return entitled
  const ended = rows.filter((row) => row.status !== 'incomplete')
  return (
    ended.sort((a, b) => (b.periodStart?.getTime() ?? 0) - (a.periodStart?.getTime() ?? 0))[0] ??
    null
  )
}

/** Whether the workspace may have a cloud computer: always, unless billing is on. */
export async function cloudEntitled(workspaceId: string) {
  if (!billingEnabled()) return true
  const plan = await workspacePlan(workspaceId)
  return !!plan && entitles(plan.status)
}

export const CLOUD_PLAN_REQUIRED =
  'The cloud computer comes with Brigade Cloud: subscribe in Settings › Billing'

/** 402 unless the workspace has the Cloud plan. */
export async function requireCloudPlan(workspaceId: string) {
  if (!(await cloudEntitled(workspaceId)))
    throw new HTTPException(402, { message: CLOUD_PLAN_REQUIRED })
}

/**
 * `run` alone for the workspace's billing: no other Checkout, event or read for it meanwhile,
 * whichever Worker or process it reaches. Its writes go through `tx`, the lock's transaction:
 * should `run` outlive the lock, they fail and are rolled back rather than land after another
 * run's.
 */
function withWorkspaceLock<T>(
  workspaceId: string,
  run: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`billing:${workspaceId}`}))`
      return run(tx)
    },
    { timeout: billingTiming.lockMs, maxWait: billingTiming.lockMs },
  )
}

const fromUnix = (seconds: number | null | undefined) => (seconds ? new Date(seconds * 1000) : null)

/**
 * A Stripe subscription, as Stripe has it now, on the workspace's row: the row already naming
 * it, else the one its Checkout was for (`rowId`, from Brigade's own metadata), else a new one.
 */
async function savePlan(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  subscription: Stripe.Subscription,
  rowId?: string,
) {
  const item = subscription.items.data[0]
  const state = {
    stripeSubscriptionId: subscription.id,
    stripeCustomerId:
      typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id,
    status: subscription.status,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    cancelAt: fromUnix(subscription.cancel_at),
    canceledAt: fromUnix(subscription.canceled_at),
    endedAt: fromUnix(subscription.ended_at),
    ...(item && {
      periodStart: fromUnix(item.current_period_start),
      periodEnd: fromUnix(item.current_period_end),
    }),
  }
  const row =
    (await tx.billingSubscription.findFirst({
      where: { workspaceId, stripeSubscriptionId: subscription.id },
    })) ??
    (rowId
      ? await tx.billingSubscription.findFirst({
          where: { id: rowId, workspaceId, stripeSubscriptionId: null },
        })
      : null)
  return row
    ? tx.billingSubscription.update({ where: { id: row.id }, data: state })
    : tx.billingSubscription.create({ data: { workspaceId, plan: CLOUD_PLAN.name, ...state } })
}

/**
 * Read the subscription from Stripe and keep what it says, then let the cloud computer
 * follow. A subscription that names another workspace, or none (another product's), is
 * left alone. Throws when Stripe cannot be read, the lock was lost or the cloud computer
 * could not follow: the event is to be sent again.
 */
export async function reconcile(target: {
  workspaceId: string
  subscriptionId: string
  rowId?: string
}) {
  const { workspaceId } = target
  if (!stripeClient) return
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } })
  if (!workspace) {
    // Organizations are not deleted while a subscription runs (guardOrganizationDeletion).
    console.error(`billing: ${target.subscriptionId} names ${workspaceId}, which is gone`)
    return
  }
  const saved = await withWorkspaceLock(workspaceId, async (tx) => {
    const subscription = await stripeClient!.subscriptions.retrieve(target.subscriptionId)
    if (subscription.metadata?.workspaceId !== workspaceId) return false
    await savePlan(tx, workspaceId, subscription, target.rowId)
    return true
  })
  if (saved) await applyPlan(workspaceId)
}

/** What a webhook event is about, from Brigade's metadata: its workspace and subscription. */
export function eventTarget(type: string, object: Record<string, any>) {
  const metadata = (object.metadata ?? {}) as Record<string, string>
  if (!metadata.workspaceId) return null
  if (type === 'checkout.session.completed' && object.mode === 'subscription') {
    const subscription = object.subscription
    const subscriptionId = typeof subscription === 'string' ? subscription : subscription?.id
    return subscriptionId
      ? { workspaceId: metadata.workspaceId, subscriptionId, rowId: metadata.rowId }
      : null
  }
  if (type.startsWith('customer.subscription.'))
    return { workspaceId: metadata.workspaceId, subscriptionId: object.id as string }
  return null
}

/**
 * Stripe's webhook ({API_URL}/api/billing/webhook): verified by its signature, then reconcile.
 * 200 once done, or for an event that is not Brigade's; 503 when it could not be done, so
 * Stripe sends the event again.
 */
export async function stripeWebhook(request: Request) {
  const signature = request.headers.get('stripe-signature')
  if (!stripeClient || !env.STRIPE_WEBHOOK_SECRET || !signature)
    return Response.json({ error: 'Not a Stripe event' }, { status: 400 })
  let event: Stripe.Event
  try {
    event = await stripeClient.webhooks.constructEventAsync(
      await request.text(),
      signature,
      env.STRIPE_WEBHOOK_SECRET,
    )
  } catch {
    noteFailure('stripe-signature', 'a request to the billing webhook failed its signature check')
    return Response.json({ error: 'Not a Stripe event' }, { status: 400 })
  }
  const target = eventTarget(event.type, event.data.object)
  if (!target) return Response.json({ received: true })
  try {
    await reconcile(target)
  } catch (error) {
    console.error(`billing: ${event.type} ${event.id} not reconciled`, error)
    noteFailure(
      'stripe-webhook',
      `${event.type} ${event.id}: ${error instanceof Error ? error.message : String(error)}`,
    )
    return Response.json({ error: 'Not reconciled: send it again' }, { status: 503 })
  }
  return Response.json({ received: true })
}

/**
 * Back from Checkout ({API_URL}/api/billing/return): its subscription, reconciled at once rather
 * than when the webhook comes. Needs no session: it only reads Stripe and keeps what Stripe says.
 */
export async function checkoutReturn(sessionId: string | undefined) {
  if (!stripeClient || !sessionId) return
  const session = await stripeClient.checkout.sessions.retrieve(sessionId)
  const target = eventTarget('checkout.session.completed', session)
  if (target) await reconcile(target)
}

/**
 * Without a webhook (a preview), changes made in Stripe (a cancellation in its portal) reach
 * Brigade only by asking: on reading the plan. With one, the row as it is.
 */
export async function refreshPlan(workspaceId: string) {
  const plan = await workspacePlan(workspaceId)
  if (!env.STRIPE_WEBHOOK_SECRET && plan?.stripeSubscriptionId)
    await reconcile({ workspaceId, subscriptionId: plan.stripeSubscriptionId })
  return workspacePlan(workspaceId)
}

/** Brigade's settings for Stripe's customer portal (scripts/stripe-setup.mjs), else the account's default. */
let portal: Promise<string | undefined> | undefined
export function portalConfiguration() {
  portal ??= (async () => {
    const { data } = await stripeClient!.billingPortal.configurations.list({
      active: true,
      limit: 100,
    })
    return data.find((configuration) => configuration.metadata?.brigade === 'portal')?.id
  })().catch((error) => {
    portal = undefined
    console.error('reading the customer portal settings failed', error)
    return undefined
  })
  return portal
}

/**
 * The cloud computer follows the workspace's plan as it is now: with it, the computer is
 * created on the first subscription; without it, a computer that runs, starts or is being made
 * is stopped, keeping its disk until the plan comes back. A stop that fails throws, so the
 * event is sent again; the idle check stops it meanwhile (src/cloud.ts), and a computer still
 * being made stops itself once made.
 */
export async function applyPlan(workspaceId: string) {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } })
  if (!workspace) return
  // Not imported above: src/cloud.ts imports this module.
  const { createWorkspaceComputer, shutDown } = await import('./cloud.js')
  if (await cloudEntitled(workspace.id)) {
    await createWorkspaceComputer(workspace)
    return
  }
  const computers = await prisma.computer.findMany({
    where: {
      workspaceId: workspace.id,
      kind: 'cloud',
      status: { notIn: ['stopped', 'destroyed'] },
    },
  })
  const failed: unknown[] = []
  for (const computer of computers)
    await shutDown(computer).catch((error) =>
      // One that was up is the event's to retry; a broken one, the minute check's.
      ['running', 'starting'].includes(computer.status)
        ? failed.push(error)
        : console.error(`shutting ${computer.id} down failed`, error),
    )
  if (failed.length)
    throw new AggregateError(failed, `stopping ${workspaceId}'s cloud computer failed`)
}

/**
 * The workspace's own Stripe customer, made on its first Checkout: its subscription, invoices
 * and card, and nothing else, so the portal opened for it shows only this workspace's plan,
 * whoever pays. Never a customer found by email: the account is shared with other products.
 */
async function workspaceCustomer(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  payer: { email: string },
) {
  const workspace = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId } })
  if (workspace.stripeCustomerId) return workspace.stripeCustomerId
  const customer = await stripeClient!.customers.create({
    name: workspace.name,
    email: payer.email,
    metadata: { workspaceId, product: 'brigade' },
  })
  await tx.workspace.update({
    where: { id: workspaceId },
    data: { stripeCustomerId: customer.id },
  })
  return customer.id
}

/** The customer whose portal manages the workspace's plan: the workspace's own. */
export async function workspaceCustomerId(workspaceId: string) {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } })
  return workspace?.stripeCustomerId ?? null
}

/**
 * Expire the customer's Checkouts still open, so none of them can be paid any more. One paid
 * meanwhile can no longer be expired: its subscription is then in Stripe, for the caller's
 * next look.
 */
async function closeOpenCheckouts(customer: string) {
  const stripe = stripeClient!
  for await (const open of stripe.checkout.sessions.list({ customer, status: 'open' }))
    await stripe.checkout.sessions.expire(open.id).catch(async (error: unknown) => {
      const now = await stripe.checkout.sessions.retrieve(open.id)
      if (now.status === 'open') throw error
    })
}

/** The workspace's subscription Stripe has that is not over, if any. */
async function liveSubscription(customer: string, workspaceId: string) {
  for await (const subscription of stripeClient!.subscriptions.list({ customer, status: 'all' }))
    if (subscription.metadata?.workspaceId === workspaceId && !OVER.includes(subscription.status))
      return subscription
  return null
}

/**
 * Stripe Checkout for the workspace's Cloud plan: its address. Under the workspace's lock,
 * so it can never be subscribed twice (two clicks, two tabs, two admins):
 * 1. the Checkouts still open are expired, so none can be paid from then on;
 * 2. then, a subscription Stripe has for the workspace (one of those paid just before, or
 *    paid with its webhook not here yet) becomes its plan, and no Checkout is made;
 * 3. else the new Checkout. Should the lock have been lost meanwhile, it is expired at once.
 */
export async function startCheckout(input: {
  workspaceId: string
  user: { id: string; email: string }
  /** Where Checkout comes back to: Settings › Billing or onboarding. */
  from: 'billing' | 'onboarding'
  cancelUrl: string
}) {
  const stripe = stripeClient!
  const { workspaceId, user } = input
  let made: string | undefined
  let outcome: { url: string } | { adopted: Stripe.Subscription }
  try {
    outcome = await withWorkspaceLock(workspaceId, async (tx) => {
      const { organizationId } = await tx.workspace.findUniqueOrThrow({
        where: { id: workspaceId },
      })
      if (await beingDeleted(tx, organizationId))
        throw new HTTPException(409, { message: 'This organization is being deleted' })
      const current = await workspacePlan(workspaceId, tx)
      if (current && entitles(current.status))
        throw new HTTPException(409, { message: 'This workspace already has Brigade Cloud' })
      const customer = await workspaceCustomer(tx, workspaceId, user)
      await closeOpenCheckouts(customer)
      const known = await liveSubscription(customer, workspaceId)
      if (known) {
        await savePlan(tx, workspaceId, known, known.metadata.rowId)
        return { adopted: known }
      }
      const [price] = (
        await stripe.prices.list({ lookup_keys: [CLOUD_PLAN.lookupKey], active: true, limit: 1 })
      ).data
      if (!price) throw new Error(`No Stripe price has the lookup key ${CLOUD_PLAN.lookupKey}`)
      // The row Checkout completes: an abandoned one is used again.
      const pending =
        (await tx.billingSubscription.findFirst({
          where: {
            workspaceId,
            plan: CLOUD_PLAN.name,
            status: 'incomplete',
            stripeSubscriptionId: null,
          },
        })) ??
        (await tx.billingSubscription.create({
          data: { workspaceId, plan: CLOUD_PLAN.name, status: 'incomplete' },
        }))
      // How webhooks and the return find the workspace and its row.
      const metadata = { workspaceId, rowId: pending.id, userId: user.id }
      const back = new URL('/api/billing/return', env.API_URL)
      back.searchParams.set('to', input.from)
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer,
        customer_update: { name: 'auto', address: 'auto' },
        line_items: [{ price: price.id, quantity: 1 }],
        client_reference_id: workspaceId,
        allow_promotion_codes: true,
        billing_address_collection: 'auto',
        tax_id_collection: { enabled: true },
        subscription_data: { metadata },
        metadata,
        // Stripe fills in the session's id; not encoded, or it would not.
        success_url: `${back}&session={CHECKOUT_SESSION_ID}`,
        cancel_url: input.cancelUrl,
      })
      made = session.id
      // Still the lock's: this write fails if it was lost, and the session is expired below.
      await tx.billingSubscription.update({
        where: { id: pending.id },
        data: { stripeCustomerId: customer },
      })
      return { url: session.url! }
    })
  } catch (error) {
    // Nobody saw its address: no one can pay it once expired.
    if (made)
      await stripe.checkout.sessions
        .expire(made)
        .catch((failure) => console.error(`billing: expiring ${made} failed`, failure))
    throw error
  }
  if ('url' in outcome) return outcome.url
  await applyPlan(workspaceId)
  const status = outcome.adopted.status
  throw new HTTPException(409, {
    message:
      status === 'incomplete'
        ? 'A payment for this workspace is still being processed'
        : entitles(status)
          ? 'This workspace already has Brigade Cloud'
          : 'This workspace has a subscription with an unpaid invoice: update the card in Manage billing',
  })
}

/** How long an organization stays closed to Checkout once its deletion is decided. */
const DELETION_LEASE_MS = 10 * 60_000

/** Whether a deletion of the organization is under way: one of its closings is young enough. */
async function beingDeleted(db: Db, organizationId: string) {
  const since = new Date(Date.now() - DELETION_LEASE_MS)
  return !!(await db.billingClosing.findFirst({
    where: { organizationId, createdAt: { gt: since } },
    select: { id: true },
  }))
}

/**
 * Before an organization is deleted (better-auth, src/auth.ts). First it is closed to Checkout
 * with a closing of this request's own (BillingClosing, which startCheckout reads under each
 * workspace's lock), for the few moments until it is gone; then, workspace by workspace under
 * its lock, the Checkouts still open are expired and a subscription that is not over refuses
 * the deletion: it would go on billing a workspace that is gone. Refused or failed, this
 * request removes its own closing, never another's; should the deletion fail after this, the
 * closing lapses by itself.
 */
export async function guardOrganizationDeletion(organizationId: string) {
  if (!stripeClient) return
  // The lapsed closings of deletions that failed earlier go.
  await prisma.billingClosing.deleteMany({
    where: { organizationId, createdAt: { lte: new Date(Date.now() - DELETION_LEASE_MS) } },
  })
  const closing = await prisma.billingClosing.create({
    data: { organizationId, createdAt: new Date() },
  })
  try {
    // Read once closed: a workspace made from now on cannot start a Checkout either.
    const workspaces = await prisma.workspace.findMany({ where: { organizationId } })
    for (const { id } of workspaces) {
      const live = await withWorkspaceLock(id, async (tx) => {
        const workspace = await tx.workspace.findUniqueOrThrow({ where: { id } })
        if (!workspace.stripeCustomerId) return null
        await closeOpenCheckouts(workspace.stripeCustomerId)
        return liveSubscription(workspace.stripeCustomerId, id)
      })
      if (live)
        throw new HTTPException(409, {
          message:
            'A workspace of this organization has Brigade Cloud: cancel it in Settings › Billing, then delete the organization once it has ended',
        })
    }
  } catch (error) {
    await prisma.billingClosing.deleteMany({ where: { id: closing.id } })
    throw error
  }
}
