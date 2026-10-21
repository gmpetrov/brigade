import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import pg from 'pg'

// Billing (src/billing.ts): which of a workspace's subscription rows counts, and who may have
// the cloud computer once billing is on. The database parts run against the local one of
// apps/api/.env, in an organization of their own removed at the end; without a database to
// reach, they are skipped.
const fromEnvFile = () => {
  try {
    const line = readFileSync(new URL('../.env', import.meta.url), 'utf8')
      .split('\n')
      .find((l) => l.startsWith('DATABASE_URL='))
    return line?.slice('DATABASE_URL='.length).replace(/^"|"$/g, '') || undefined
  } catch {
    return undefined
  }
}
process.env.DATABASE_URL ??= fromEnvFile() ?? 'postgresql://test@localhost/test'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
// Billing on, with a key that is never used: nothing here calls Stripe.
process.env.STRIPE_SECRET_KEY = 'sk_test_never_called'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_billing_test'

async function reachable() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  })
  try {
    await client.connect()
    await client.query('select "id" from "BillingSubscription" limit 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}
const skip = (await reachable()) ? false : 'no database to reach (apps/api/.env DATABASE_URL)'

const { prisma } = await import('../src/db.js')
const billing = await import('../src/billing.js')
const { HTTPException } = await import('hono/http-exception')
const { auth } = await import('../src/auth.js')

const row = (status: string, periodStart: string | null) => ({
  status,
  periodStart: periodStart ? new Date(periodStart) : null,
})

test('the row that entitles the workspace counts first', () => {
  const active = row('active', '2026-01-01')
  assert.equal(billing.pickPlan([row('canceled', '2026-09-01'), active]), active)
  assert.equal(
    billing.pickPlan([row('unpaid', '2026-09-01'), row('past_due', '2026-02-01')]).status,
    'past_due',
  )
})

test('else the latest that got past checkout, never an abandoned one', () => {
  const latest = row('canceled', '2026-09-01')
  assert.equal(
    billing.pickPlan([row('canceled', '2026-03-01'), latest, row('incomplete', null)]),
    latest,
  )
  assert.equal(billing.pickPlan([row('incomplete', null)]), null)
  assert.equal(billing.pickPlan([]), null)
})

test('the statuses that keep the cloud computer', () => {
  for (const status of ['active', 'trialing', 'past_due']) assert.ok(billing.entitles(status))
  for (const status of ['canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused'])
    assert.ok(!billing.entitles(status), status)
})

const id = randomUUID().slice(0, 8)
const ids = {
  organization: `org-billing-${id}`,
  owner: `user-billing-owner-${id}`,
  member: `user-billing-member-${id}`,
  stranger: `user-billing-stranger-${id}`,
}
let workspaceId = ''
/** For checkouts: one in the same organization, one in another. */
const workspaces = { handoff: '', other: '' }

before(async () => {
  if (skip) return
  await prisma.organization.create({
    data: { id: ids.organization, name: 'Billing test', slug: ids.organization },
  })
  for (const user of [ids.owner, ids.member, ids.stranger])
    await prisma.user.create({ data: { id: user, name: user, email: `${user}@example.com` } })
  await prisma.member.create({
    data: {
      id: `m-${ids.owner}`,
      organizationId: ids.organization,
      userId: ids.owner,
      role: 'owner',
    },
  })
  await prisma.member.create({
    data: {
      id: `m-${ids.member}`,
      organizationId: ids.organization,
      userId: ids.member,
      role: 'member',
    },
  })
  workspaceId = (
    await prisma.workspace.create({ data: { organizationId: ids.organization, name: 'Billing' } })
  ).id
  workspaces.handoff = (
    await prisma.workspace.create({ data: { organizationId: ids.organization, name: 'Handoff' } })
  ).id
  // Another organization's workspace, paid by the same person.
  await prisma.organization.create({
    data: { id: `${ids.organization}-2`, name: 'Billing test 2', slug: `${ids.organization}-2` },
  })
  workspaces.other = (
    await prisma.workspace.create({
      data: { organizationId: `${ids.organization}-2`, name: 'Elsewhere' },
    })
  ).id
})

after(async () => {
  if (skip) return
  await prisma.billingSubscription.deleteMany({ where: { referenceId: workspaceId } })
  await prisma.billingSubscription.deleteMany({
    where: { referenceId: { in: [workspaces.handoff, workspaces.other] } },
  })
  await prisma.organization.deleteMany({ where: { id: `${ids.organization}-2` } })
  await prisma.organization.deleteMany({ where: { id: ids.organization } })
  await prisma.user.deleteMany({ where: { id: { in: [ids.owner, ids.member, ids.stranger] } } })
  await prisma.$disconnect()
})

test('without a plan, no cloud computer', { skip }, async () => {
  assert.equal(await billing.cloudEntitled(workspaceId), false)
  await assert.rejects(billing.requireCloudPlan(workspaceId), (error: unknown) => {
    assert.ok(error instanceof HTTPException)
    assert.equal(error.status, 402)
    return true
  })
})

test('an abandoned checkout gives nothing; a complimentary plan does', { skip }, async () => {
  await prisma.billingSubscription.create({
    data: { id: `sub-${id}-1`, plan: 'cloud', referenceId: workspaceId, status: 'incomplete' },
  })
  assert.equal(await billing.cloudEntitled(workspaceId), false)
  assert.equal(await billing.workspacePlan(workspaceId), null)
  await prisma.billingSubscription.create({
    data: { id: `sub-${id}-2`, plan: 'cloud', referenceId: workspaceId, status: 'active' },
  })
  assert.equal(await billing.cloudEntitled(workspaceId), true)
  await billing.requireCloudPlan(workspaceId)
  // No Stripe subscription behind it: nothing to ask Stripe.
  const plan = await billing.workspacePlan(workspaceId)
  assert.equal(await billing.refreshPlan(plan!), plan)
})

test('a plan that ended takes the cloud computer away', { skip }, async () => {
  await prisma.billingSubscription.update({
    where: { id: `sub-${id}-2` },
    data: { status: 'canceled' },
  })
  assert.equal(await billing.cloudEntitled(workspaceId), false)
  assert.equal((await billing.workspacePlan(workspaceId))?.status, 'canceled')
  // Its computer is stopped, when it has one; here there is none.
  await billing.planChanged({ referenceId: workspaceId })
})

test('a subscription that names no workspace changes nothing', { skip }, async () => {
  await billing.planChanged({ referenceId: ids.owner })
})

test('members see the plan, owners and admins change it, others nothing', { skip }, async () => {
  assert.equal(await billing.mayBill(ids.owner, workspaceId, 'upgrade-subscription'), true)
  assert.equal(await billing.mayBill(ids.owner, workspaceId, 'billing-portal'), true)
  assert.equal(await billing.mayBill(ids.member, workspaceId, 'list-subscription'), true)
  assert.equal(await billing.mayBill(ids.member, workspaceId, 'upgrade-subscription'), false)
  assert.equal(await billing.mayBill(ids.member, workspaceId, 'cancel-subscription'), false)
  assert.equal(await billing.mayBill(ids.stranger, workspaceId, 'list-subscription'), false)
  assert.equal(await billing.mayBill(ids.owner, 'no-such-workspace', 'upgrade-subscription'), false)
})

/** A Stripe event delivered to the plugin's webhook, signed as Stripe would. */
async function deliver(type: string, object: Record<string, unknown>) {
  const payload = JSON.stringify({
    id: `evt_${randomUUID()}`,
    object: 'event',
    type,
    data: { object },
  })
  const signature = billing.stripeClient!.webhooks.generateTestHeaderString({
    payload,
    secret: process.env.STRIPE_WEBHOOK_SECRET!,
  })
  const response = await auth.handler(
    new Request(`${process.env.API_URL ?? 'http://localhost:3001'}/api/auth/stripe/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      body: payload,
    }),
  )
  assert.equal(response.status, 200, await response.text())
}

/** Stripe, faked where billing calls it: its subscriptions as they are now, its sessions. */
const stripe = billing.stripeClient!
const stripeNow = new Map<string, Record<string, unknown>>()
stripe.subscriptions.retrieve = (async (subscriptionId: string) =>
  stripeNow.get(subscriptionId)) as never

const now = Math.floor(Date.now() / 1000)
const stripeSubscription = (fields: Record<string, unknown>) => ({
  id: `sub_test_${id}`,
  object: 'subscription',
  customer: `cus_test_${id}`,
  status: 'active',
  cancel_at_period_end: false,
  cancel_at: null,
  canceled_at: null,
  ended_at: null,
  metadata: {},
  items: {
    data: [
      {
        quantity: 1,
        current_period_start: now,
        current_period_end: now + 30 * 86400,
        price: {
          id: 'price_cloud',
          lookup_key: 'brigade_cloud_monthly',
          recurring: { interval: 'month' },
        },
      },
    ],
  },
  ...fields,
})

test("Stripe's webhook keeps the workspace's plan in step", { skip }, async () => {
  await prisma.billingSubscription.create({
    data: {
      id: `sub-${id}-3`,
      plan: 'cloud',
      referenceId: workspaceId,
      status: 'active',
      stripeCustomerId: `cus_test_${id}`,
      stripeSubscriptionId: `sub_test_${id}`,
    },
  })
  assert.equal(await billing.cloudEntitled(workspaceId), true)

  // Canceled in the portal: it runs to the end of the period.
  const canceling = stripeSubscription({ cancel_at_period_end: true, cancel_at: now + 30 * 86400 })
  stripeNow.set(`sub_test_${id}`, canceling)
  await deliver('customer.subscription.updated', canceling)
  let plan = await prisma.billingSubscription.findUniqueOrThrow({ where: { id: `sub-${id}-3` } })
  assert.equal(plan.status, 'active')
  assert.equal(plan.cancelAtPeriodEnd, true)
  assert.equal(plan.periodEnd?.getTime(), (now + 30 * 86400) * 1000)
  assert.equal(await billing.cloudEntitled(workspaceId), true)

  // The period is over: the workspace loses the cloud computer.
  const ended = stripeSubscription({ status: 'canceled', ended_at: now })
  stripeNow.set(`sub_test_${id}`, ended)
  await deliver('customer.subscription.deleted', ended)
  plan = await prisma.billingSubscription.findUniqueOrThrow({ where: { id: `sub-${id}-3` } })
  assert.equal(plan.status, 'canceled')
  assert.equal(await billing.cloudEntitled(workspaceId), false)

  // An older "updated, active" arriving late: Stripe says canceled, and canceled it stays.
  await deliver('customer.subscription.updated', stripeSubscription({}))
  plan = await prisma.billingSubscription.findUniqueOrThrow({ where: { id: `sub-${id}-3` } })
  assert.equal(plan.status, 'canceled')
  assert.equal(await billing.cloudEntitled(workspaceId), false)
})

test("another product's subscription in the same account changes nothing", { skip }, async () => {
  await deliver(
    'customer.subscription.updated',
    stripeSubscription({
      id: `sub_other_${id}`,
      customer: `cus_other_${id}`,
      status: 'past_due',
      items: {
        data: [
          {
            quantity: 1,
            current_period_start: now,
            current_period_end: now,
            price: { id: 'price_papers', lookup_key: null, recurring: { interval: 'month' } },
          },
        ],
      },
    }),
  )
  const rows = await prisma.billingSubscription.findMany({ where: { referenceId: workspaceId } })
  assert.deepEqual(rows.map((row) => row.status).sort(), ['canceled', 'canceled', 'incomplete'])
})

/** Checkout sessions and customers, as the fake Stripe has them. */
const made = {
  customers: [] as { id: string; metadata: Record<string, string> }[],
  sessions: [] as {
    id: string
    customer: string
    status: string
    url: string
    metadata: Record<string, string>
  }[],
  portals: [] as { customer: string }[],
}
const price = {
  id: 'price_cloud',
  lookup_key: 'brigade_cloud_monthly',
  recurring: { interval: 'month' },
}
stripe.customers.create = (async (params: { metadata: Record<string, string> }) => {
  const customer = { id: `cus_made_${id}_${made.customers.length + 1}`, ...params }
  made.customers.push(customer)
  return customer
}) as never
stripe.prices.list = (async () => ({ data: [price] })) as never
stripe.checkout.sessions.list = ((params: { customer: string; status: string }) =>
  (async function* () {
    for (const session of made.sessions)
      if (session.customer === params.customer && session.status === params.status) yield session
  })()) as never
stripe.checkout.sessions.expire = (async (sessionId: string) => {
  const session = made.sessions.find((s) => s.id === sessionId)!
  session.status = 'expired'
  return session
}) as never
stripe.checkout.sessions.create = (async (params: {
  customer: string
  metadata: Record<string, string>
}) => {
  // Stripe takes a moment: two checkouts at once overlap here.
  await new Promise((resolve) => setTimeout(resolve, 50))
  const sessionId = `cs_${id}_${made.sessions.length + 1}`
  const session = {
    id: sessionId,
    ...params,
    status: 'open',
    url: `https://checkout.test/${sessionId}`,
  }
  made.sessions.push(session)
  return session
}) as never

const checkout = (workspaceId: string, user: string) =>
  billing.startCheckout({
    workspaceId,
    user: { id: user, email: `${user}@example.com` },
    successUrl: 'http://localhost:3000/app/billing?subscribed=1',
    cancelUrl: 'http://localhost:3000/app/billing',
  })

const openSessions = (customer: string | null) =>
  made.sessions.filter((s) => s.customer === customer && s.status === 'open')

test('one payable Checkout per workspace, even started twice at once', { skip }, async () => {
  await Promise.all([
    checkout(workspaces.handoff, ids.owner),
    checkout(workspaces.handoff, ids.owner),
  ])
  const customer = await billing.workspaceCustomerId(workspaces.handoff)
  assert.ok(customer)
  assert.equal(openSessions(customer).length, 1)
  // A third, later: the one still open is expired first.
  await checkout(workspaces.handoff, ids.member)
  assert.equal(openSessions(customer).length, 1)
  assert.equal(made.sessions.filter((s) => s.customer === customer).length, 3)
  // All for one row, the workspace's.
  const rows = await prisma.billingSubscription.findMany({
    where: { referenceId: workspaces.handoff },
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.stripeCustomerId, customer)
  assert.ok(made.sessions.every((s) => s.metadata.subscriptionId === rows[0]!.id))
})

test(
  "whoever pays, the subscription is the workspace's, on its own customer",
  { skip },
  async () => {
    const customer = await billing.workspaceCustomerId(workspaces.handoff)
    const [session] = openSessions(customer)
    // The member who started the last checkout pays it.
    const subscriptionId = `sub_handoff_${id}`
    const paid = stripeSubscription({ id: subscriptionId, customer, metadata: session!.metadata })
    stripeNow.set(subscriptionId, paid)
    await deliver('checkout.session.completed', {
      id: session!.id,
      object: 'checkout.session',
      mode: 'subscription',
      subscription: subscriptionId,
      customer,
      client_reference_id: workspaces.handoff,
      metadata: session!.metadata,
    })
    const plan = await billing.workspacePlan(workspaces.handoff)
    assert.equal(plan?.status, 'active')
    assert.equal(plan?.stripeSubscriptionId, subscriptionId)
    assert.equal(plan?.stripeCustomerId, customer)
    await assert.rejects(checkout(workspaces.handoff, ids.owner), /already has Brigade Cloud/)
  },
)

test(
  "another workspace's plan, paid by the same person, has a customer of its own",
  { skip },
  async () => {
    await checkout(workspaces.other, ids.owner)
    const here = await billing.workspaceCustomerId(workspaces.handoff)
    const there = await billing.workspaceCustomerId(workspaces.other)
    assert.ok(there)
    assert.notEqual(here, there)
    assert.deepEqual(
      made.customers.map((c) => c.metadata.workspaceId).sort(),
      [workspaces.handoff, workspaces.other].sort(),
    )
  },
)
