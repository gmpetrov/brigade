import { BillingCheckout, type BillingResponse } from '@brigade/contracts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { audit } from '../audit.js'
import { auth } from '../auth.js'
import {
  billingEnabled,
  CLOUD_PLAN,
  ensureCustomer,
  entitles,
  planChanged,
  portalConfiguration,
  refreshPlan,
  stripeClient,
  workspacePlan,
} from '../billing.js'
import { env } from '../config.js'
import { parseBody, requireRole, requireUser, requireWorkspace, type AppEnv } from '../scope.js'

const billingPage = () => `${env.WEB_URL[0]}/app/billing`
const pageOf = { billing: billingPage, onboarding: () => `${env.WEB_URL[0]}/onboarding` }

/** Settings › Billing: the workspace's plan, Checkout to subscribe, Stripe's portal to manage it. */
export const billing = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)

  .get('/', async (c) => {
    if (!billingEnabled()) return c.json<BillingResponse>({ enabled: false, plan: null })
    const stored = await workspacePlan(c.var.scope.workspaceId)
    const plan = stored && (await refreshPlan(stored))
    if (stored && plan && entitles(stored.status) !== entitles(plan.status)) await planChanged(plan)
    return c.json<BillingResponse>({
      enabled: true,
      plan: plan && {
        status: plan.status,
        active: entitles(plan.status),
        // Given by hand, with no Stripe subscription behind it: nothing to manage.
        complimentary: !plan.stripeSubscriptionId,
        periodEnd: plan.periodEnd?.toISOString() ?? null,
        cancelAt: plan.cancelAtPeriodEnd
          ? (plan.periodEnd?.toISOString() ?? null)
          : (plan.cancelAt?.toISOString() ?? null),
      },
    })
  })

  /** Stripe Checkout for the Cloud plan, for this workspace. Its address, to open. */
  .post('/checkout', async (c) => {
    requireRole(c.var.scope, 'owner', 'admin')
    const { from } = await parseBody(c.req.raw, BillingCheckout)
    if (!billingEnabled())
      throw new HTTPException(409, { message: 'Billing is off on this server' })
    const plan = await workspacePlan(c.var.scope.workspaceId)
    if (plan && entitles(plan.status))
      throw new HTTPException(409, { message: 'This workspace already has Brigade Cloud' })
    await ensureCustomer(c.var.userId)
    const checkout = await auth.api.upgradeSubscription({
      headers: c.req.raw.headers,
      body: {
        plan: CLOUD_PLAN.name,
        referenceId: c.var.scope.workspaceId,
        customerType: 'user',
        successUrl: `${pageOf[from]()}?subscribed=1`,
        cancelUrl: pageOf[from](),
        disableRedirect: true,
      },
    })
    await audit({
      ...c.var.scope,
      actor: { type: 'member', id: c.var.scope.memberId },
      action: 'billing.checkout_started',
      target: { type: 'workspace', id: c.var.scope.workspaceId },
    })
    return c.json({ url: checkout.url! })
  })

  /** Stripe's billing portal for the workspace's subscription: card, invoices, cancel. */
  .post('/portal', async (c) => {
    requireRole(c.var.scope, 'owner', 'admin')
    const plan = await workspacePlan(c.var.scope.workspaceId)
    if (!stripeClient || !plan?.stripeCustomerId)
      throw new HTTPException(404, { message: 'This workspace has no subscription to manage' })
    const session = await stripeClient.billingPortal.sessions.create({
      customer: plan.stripeCustomerId,
      configuration: await portalConfiguration(),
      return_url: billingPage(),
    })
    return c.json({ url: session.url })
  })
