// Billing: one paid plan, Cloud, subscribed per workspace, which gives the workspace its
// cloud computer. Brigade itself stays free on members' own machines. Stripe holds the
// subscription; BillingSubscription rows follow it. Without STRIPE_SECRET_KEY billing is off
// and every workspace has the cloud computer, as on a self-hosted Brigade.
//
// One rule keeps the rows right: they only ever take Stripe's current state, read under a
// lock on the workspace, never what an event says. Events come late, twice, out of order
// or overlapping; each one only says "look again". A read that fails changes nothing, and
// Stripe is asked to send the event again.
import { HTTPException } from 'hono/http-exception'
import Stripe from 'stripe'
import { env } from './config.js'
import { prisma } from './db.js'

export const billingEnabled = () => !!env.STRIPE_SECRET_KEY

export const stripeClient = env.STRIPE_SECRET_KEY
  ? new Stripe(env.STRIPE_SECRET_KEY, {
      // Workers have no Node http: fetch everywhere.
      httpClient: Stripe.createFetchHttpClient(),
      appInfo: { name: 'Brigade', url: 'https://www.brigade.lol' },
    })
  : null

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

/** The workspace's plan that counts: the one that entitles it, else the latest. */
export async function workspacePlan(workspaceId: string) {
  const rows = await prisma.billingSubscription.findMany({
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
 * whichever Worker or process it reaches. Stripe's answers come within the lock.
 */
function withWorkspaceLock<T>(workspaceId: string, run: () => Promise<T>) {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`billing:${workspaceId}`}))`
      return run()
    },
    { timeout: 30_000, maxWait: 30_000 },
  )
}

const fromUnix = (seconds: number | null | undefined) => (seconds ? new Date(seconds * 1000) : null)

/**
 * A Stripe subscription, as Stripe has it now, on the workspace's row: the row already naming
 * it, else the one its Checkout was for (`rowId`, from Brigade's own metadata), else a new one.
 * Under the workspace's lock.
 */
async function savePlan(workspaceId: string, subscription: Stripe.Subscription, rowId?: string) {
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
    (await prisma.billingSubscription.findFirst({
      where: { workspaceId, stripeSubscriptionId: subscription.id },
    })) ??
    (rowId
      ? await prisma.billingSubscription.findFirst({
          where: { id: rowId, workspaceId, stripeSubscriptionId: null },
        })
      : null)
  return row
    ? prisma.billingSubscription.update({ where: { id: row.id }, data: state })
    : prisma.billingSubscription.create({ data: { workspaceId, plan: CLOUD_PLAN.name, ...state } })
}

/**
 * Read the subscription from Stripe and keep what it says, then let the cloud computer
 * follow. A subscription that names another workspace, or none (another product's), is
 * left alone. Throws when Stripe cannot be read: nothing was changed.
 */
export async function reconcile(target: {
  workspaceId: string
  subscriptionId: string
  rowId?: string
}) {
  const { workspaceId } = target
  if (!stripeClient) return
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } })
  if (!workspace) return
  await withWorkspaceLock(workspaceId, async () => {
    const subscription = await stripeClient!.subscriptions.retrieve(target.subscriptionId)
    if (subscription.metadata?.workspaceId !== workspaceId) return
    await savePlan(workspaceId, subscription, target.rowId)
    await planChanged(workspaceId)
  })
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
 * 200 once done, or for an event that is not Brigade's; 503 when Stripe could not be read,
 * so it sends the event again.
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
    return Response.json({ error: 'Not a Stripe event' }, { status: 400 })
  }
  const target = eventTarget(event.type, event.data.object)
  if (!target) return Response.json({ received: true })
  try {
    await reconcile(target)
  } catch (error) {
    console.error(`billing: ${event.type} ${event.id} not reconciled`, error)
    return Response.json({ error: 'Stripe could not be read: send it again' }, { status: 503 })
  }
  return Response.json({ received: true })
}

/**
 * Back from Checkout ({API_URL}/api/billing/return): its subscription, reconciled at once rather
 * than when the webhook comes. Then the page it came from. Needs no session: it only reads
 * Stripe and keeps what Stripe says.
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
 * After a workspace's plan changed: a workspace that has it gets its cloud computer (created
 * on its first subscription); one that lost it has its computer stopped, which keeps its disk
 * until the plan comes back.
 */
export async function planChanged(workspaceId: string) {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } })
  if (!workspace) return
  // Not imported above: src/cloud.ts imports this module.
  const { createWorkspaceComputer, stopComputer } = await import('./cloud.js')
  if (await cloudEntitled(workspace.id)) {
    await createWorkspaceComputer(workspace)
    return
  }
  const computers = await prisma.computer.findMany({
    where: { workspaceId: workspace.id, kind: 'cloud', status: { in: ['running', 'starting'] } },
  })
  for (const computer of computers)
    await stopComputer(computer, { type: 'system', id: 'billing' }).catch((error) =>
      console.error(`stopping ${computer.id} after its plan ended failed`, error),
    )
}

/**
 * The workspace's own Stripe customer, made on its first Checkout: its subscription, invoices
 * and card, and nothing else, so the portal opened for it shows only this workspace's plan,
 * whoever pays. Never a customer found by email: the account is shared with other products.
 */
async function workspaceCustomer(workspaceId: string, payer: { email: string }) {
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })
  if (workspace.stripeCustomerId) return workspace.stripeCustomerId
  const customer = await stripeClient!.customers.create({
    name: workspace.name,
    email: payer.email,
    metadata: { workspaceId, product: 'brigade' },
  })
  await prisma.workspace.update({
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
 * Stripe Checkout for the workspace's Cloud plan: its address. Under the workspace's lock,
 * so it can never be subscribed twice (two clicks, two tabs, two admins):
 * - a subscription Stripe already has for it (paid, its webhook not here yet, or the payer
 *   closed the tab before coming back) becomes its plan, and no Checkout is made;
 * - the Checkouts still open are expired before a new one is made.
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
  return withWorkspaceLock(workspaceId, async () => {
    const current = await workspacePlan(workspaceId)
    if (current && entitles(current.status))
      throw new HTTPException(409, { message: 'This workspace already has Brigade Cloud' })
    const customer = await workspaceCustomer(workspaceId, user)
    for await (const known of stripe.subscriptions.list({ customer, status: 'all' })) {
      if (known.metadata?.workspaceId !== workspaceId || OVER.includes(known.status)) continue
      await savePlan(workspaceId, known, known.metadata.rowId)
      await planChanged(workspaceId)
      throw new HTTPException(409, {
        message:
          known.status === 'incomplete'
            ? 'A payment for this workspace is still being processed'
            : entitles(known.status)
              ? 'This workspace already has Brigade Cloud'
              : 'This workspace has a subscription with an unpaid invoice: update the card in Manage billing',
      })
    }
    for await (const open of stripe.checkout.sessions.list({ customer, status: 'open' }))
      await stripe.checkout.sessions.expire(open.id)
    const [price] = (
      await stripe.prices.list({ lookup_keys: [CLOUD_PLAN.lookupKey], active: true, limit: 1 })
    ).data
    if (!price) throw new Error(`No Stripe price has the lookup key ${CLOUD_PLAN.lookupKey}`)
    // The row Checkout completes: an abandoned one is used again.
    const pending =
      (await prisma.billingSubscription.findFirst({
        where: {
          workspaceId,
          plan: CLOUD_PLAN.name,
          status: 'incomplete',
          stripeSubscriptionId: null,
        },
      })) ??
      (await prisma.billingSubscription.create({
        data: { workspaceId, plan: CLOUD_PLAN.name, status: 'incomplete' },
      }))
    await prisma.billingSubscription.update({
      where: { id: pending.id },
      data: { stripeCustomerId: customer },
    })
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
    return session.url!
  })
}
