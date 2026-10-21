// Billing: one paid plan, Cloud, subscribed per workspace, which gives the workspace its
// cloud computer. Brigade itself stays free on members' own machines. Stripe holds the
// subscription; better-auth's stripe plugin (src/auth.ts) makes its Checkout and keeps
// the BillingSubscription rows in step through Stripe's webhook. Without STRIPE_SECRET_KEY
// billing is off and every workspace has the cloud computer, as on a self-hosted Brigade.
import type { StripePlan, Subscription } from '@better-auth/stripe'
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
export const CLOUD_PLAN = {
  name: 'cloud',
  lookupKey: 'brigade_cloud_monthly',
} satisfies StripePlan

/**
 * The statuses that keep the cloud computer. past_due too: Stripe retries the payment for a
 * while, and only once it gives up (unpaid or canceled) does the workspace lose it.
 */
const ENTITLED = ['active', 'trialing', 'past_due']

export const entitles = (status: string) => ENTITLED.includes(status)

/** The workspace's plan that counts: the one that entitles it, else the latest. */
export async function workspacePlan(workspaceId: string) {
  const rows = await prisma.billingSubscription.findMany({
    where: { referenceId: workspaceId, plan: CLOUD_PLAN.name },
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

type PlanRow = NonNullable<Awaited<ReturnType<typeof workspacePlan>>>

const fromUnix = (seconds: number | null | undefined) => (seconds ? new Date(seconds * 1000) : null)

/**
 * Without a webhook (a preview), changes made in Stripe (a cancellation in its portal) reach
 * Brigade only by asking: the plan as Stripe has it now, saved. With one, the row as it is.
 */
export async function refreshPlan(plan: PlanRow): Promise<PlanRow> {
  if (!stripeClient || env.STRIPE_WEBHOOK_SECRET || !plan.stripeSubscriptionId) return plan
  const subscription = await stripeClient.subscriptions.retrieve(plan.stripeSubscriptionId)
  const item = subscription.items.data[0]
  return prisma.billingSubscription.update({
    where: { id: plan.id },
    data: {
      status: subscription.status,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      cancelAt: fromUnix(subscription.cancel_at),
      canceledAt: fromUnix(subscription.canceled_at),
      endedAt: fromUnix(subscription.ended_at),
      ...(item && {
        periodStart: fromUnix(item.current_period_start),
        periodEnd: fromUnix(item.current_period_end),
      }),
    },
  })
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
 * After Stripe changed a workspace's plan: a workspace that has it gets its cloud computer
 * (created on its first subscription); one that lost it has its computer stopped, which
 * keeps its disk until the plan comes back.
 */
export async function planChanged(subscription: Pick<Subscription, 'referenceId'>) {
  const workspace = await prisma.workspace.findUnique({ where: { id: subscription.referenceId } })
  // A subscription made in Stripe's dashboard names a user, not a workspace.
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
 * Whether the signed-in user may act on the workspace's plan: members see it, owners and
 * admins subscribe and manage it. The plugin asks for each of its endpoints.
 */
export async function mayBill(userId: string, workspaceId: string, action: string) {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } })
  if (!workspace) return false
  const member = await prisma.member.findUnique({
    where: { organizationId_userId: { organizationId: workspace.organizationId, userId } },
  })
  if (!member) return false
  return action === 'list-subscription' || member.role === 'owner' || member.role === 'admin'
}

/**
 * The member's own Stripe customer, made by Brigade before their first Checkout. Left to the
 * plugin, it would reuse any customer of the account with their email, and the account is
 * shared with other products: their subscriptions' events would then reach this one's rows.
 */
export async function ensureCustomer(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
  if (user.stripeCustomerId) return user.stripeCustomerId
  const customer = await stripeClient!.customers.create({
    email: user.email,
    name: user.name,
    // The plugin's own keys: it knows the customer as this user's.
    metadata: { userId: user.id, customerType: 'user', product: 'brigade' },
  })
  // Two checkouts at once: the first customer saved wins.
  await prisma.user.updateMany({
    where: { id: user.id, stripeCustomerId: null },
    data: { stripeCustomerId: customer.id },
  })
  return customer.id
}
