import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import pg from 'pg'

// Billing (src/billing.ts): which of a workspace's subscription rows counts, who has the cloud
// computer, Checkout, and Stripe's webhook, with Stripe faked where billing calls it. The
// database parts run against the local one of apps/api/.env, in organizations of their own
// removed at the end; without a database to reach, they are skipped.
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
// Billing on, with a key that reaches nothing: every Stripe call billing makes is faked below.
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

const row = (status: string, periodStart: string | null) => ({
  status,
  periodStart: periodStart ? new Date(periodStart) : null,
})

test('the row that entitles the workspace counts first', () => {
  const active = row('active', '2026-01-01')
  assert.equal(billing.pickPlan([row('canceled', '2026-09-01'), active]), active)
  assert.equal(
    billing.pickPlan([row('unpaid', '2026-09-01'), row('past_due', '2026-02-01')])?.status,
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

// --- Stripe, faked -------------------------------------------------------------------------

const stripe = billing.stripeClient!
const now = Math.floor(Date.now() / 1000)
const price = {
  id: 'price_cloud',
  lookup_key: 'brigade_cloud_monthly',
  recurring: { interval: 'month' },
}
type Fake = Record<string, any>
const fake = {
  /** Subscriptions as Stripe has them now, by id. */
  subscriptions: new Map<string, Fake>(),
  sessions: [] as Fake[],
  /** The next subscription reads fail, as when Stripe cannot be reached. */
  failReads: 0,
  /** The next subscription reads answer with what Stripe had when asked, this much later. */
  readDelaysMs: [] as number[],
}
stripe.subscriptions.retrieve = (async (subscriptionId: string) => {
  if (fake.failReads > 0) {
    fake.failReads--
    throw new Error('Stripe is unreachable')
  }
  const then = structuredClone(fake.subscriptions.get(subscriptionId))
  const delay = fake.readDelaysMs.shift()
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
  return then
}) as never
stripe.subscriptions.list = ((params: { customer: string }) =>
  (async function* () {
    for (const subscription of fake.subscriptions.values())
      if (subscription.customer === params.customer) yield structuredClone(subscription)
  })()) as never
stripe.customers.create = (async (params: Fake) => ({
  id: `cus_${randomUUID().slice(0, 8)}`,
  ...params,
})) as never
stripe.prices.list = (async () => ({ data: [price] })) as never
stripe.checkout.sessions.list = ((params: { customer: string; status: string }) =>
  (async function* () {
    for (const session of fake.sessions)
      if (session.customer === params.customer && session.status === params.status) yield session
  })()) as never
stripe.checkout.sessions.expire = (async (sessionId: string) => {
  const session = fake.sessions.find((s) => s.id === sessionId)!
  session.status = 'expired'
  return session
}) as never
stripe.checkout.sessions.create = (async (params: Fake) => {
  // Stripe takes a moment: two checkouts at once overlap here.
  await new Promise((resolve) => setTimeout(resolve, 50))
  const id = `cs_${randomUUID().slice(0, 8)}`
  const session = {
    id,
    object: 'checkout.session',
    ...params,
    status: 'open',
    url: `https://checkout.test/${id}`,
  }
  fake.sessions.push(session)
  return session
}) as never
stripe.checkout.sessions.retrieve = (async (sessionId: string) =>
  fake.sessions.find((s) => s.id === sessionId)) as never

/** A Stripe subscription, as Stripe would have it. */
const subscription = (fields: Fake): Fake => ({
  id: `sub_${randomUUID().slice(0, 8)}`,
  object: 'subscription',
  status: 'active',
  cancel_at_period_end: false,
  cancel_at: null,
  canceled_at: null,
  ended_at: null,
  metadata: {},
  items: {
    data: [{ quantity: 1, current_period_start: now, current_period_end: now + 30 * 86400, price }],
  },
  ...fields,
})

/** Pay a Checkout session: Stripe now has its subscription, active. */
function pay(session: Fake) {
  const paid = subscription({
    customer: session.customer,
    metadata: session.subscription_data.metadata,
  })
  fake.subscriptions.set(paid.id, paid)
  session.status = 'complete'
  session.subscription = paid.id
  return paid
}

/** An event delivered to the webhook, signed as Stripe would; Brigade's answer. */
async function deliver(type: string, object: Fake) {
  const payload = JSON.stringify({
    id: `evt_${randomUUID()}`,
    object: 'event',
    type,
    data: { object },
  })
  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: process.env.STRIPE_WEBHOOK_SECRET!,
  })
  return billing.stripeWebhook(
    new Request('http://localhost:3001/api/billing/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      body: payload,
    }),
  )
}

const completed = (session: Fake) => ({ ...session, mode: 'subscription' })

// --- Fixtures ------------------------------------------------------------------------------

const id = randomUUID().slice(0, 8)
const ids = {
  organization: `org-billing-${id}`,
  other: `org-billing-other-${id}`,
  owner: `user-billing-owner-${id}`,
  member: `user-billing-member-${id}`,
}
/** Workspaces, each for a few tests: billing's state is per workspace. */
const ws: Record<string, string> = {}
const checkout = (workspaceId: string, userId = ids.owner) =>
  billing.startCheckout({
    workspaceId,
    user: { id: userId, email: `${userId}@example.com` },
    from: 'billing',
    cancelUrl: 'http://localhost:3000/app/billing',
  })
const sessionsOf = async (workspaceId: string, status = 'open') => {
  const customer = await billing.workspaceCustomerId(workspaceId)
  return fake.sessions.filter((s) => s.customer === customer && s.status === status)
}
const statusOf = async (workspaceId: string) => (await billing.workspacePlan(workspaceId))?.status

before(async () => {
  if (skip) return
  for (const organization of [ids.organization, ids.other])
    await prisma.organization.create({
      data: { id: organization, name: organization, slug: organization },
    })
  for (const userId of [ids.owner, ids.member])
    await prisma.user.create({
      data: { id: userId, name: userId, email: `${userId}@example.com` },
    })
  for (const name of ['plans', 'webhook', 'late', 'overlap', 'firstRead', 'checkout', 'paid'])
    ws[name] = (
      await prisma.workspace.create({ data: { organizationId: ids.organization, name } })
    ).id
  ws.elsewhere = (
    await prisma.workspace.create({ data: { organizationId: ids.other, name: 'elsewhere' } })
  ).id
})

after(async () => {
  if (skip) return
  await prisma.organization.deleteMany({ where: { id: { in: [ids.organization, ids.other] } } })
  await prisma.user.deleteMany({ where: { id: { in: [ids.owner, ids.member] } } })
  await prisma.$disconnect()
})

// --- Plans ---------------------------------------------------------------------------------

test('without a plan, no cloud computer', { skip }, async () => {
  assert.equal(await billing.cloudEntitled(ws.plans!), false)
  await assert.rejects(billing.requireCloudPlan(ws.plans!), (error: unknown) => {
    assert.ok(error instanceof HTTPException)
    assert.equal(error.status, 402)
    return true
  })
})

test('an abandoned checkout gives nothing; a complimentary plan does', { skip }, async () => {
  await prisma.billingSubscription.create({
    data: { workspaceId: ws.plans!, plan: 'cloud', status: 'incomplete' },
  })
  assert.equal(await billing.cloudEntitled(ws.plans!), false)
  assert.equal(await billing.workspacePlan(ws.plans!), null)
  const comp = await prisma.billingSubscription.create({
    data: { workspaceId: ws.plans!, plan: 'cloud', status: 'active' },
  })
  assert.equal(await billing.cloudEntitled(ws.plans!), true)
  await billing.requireCloudPlan(ws.plans!)
  // Ended by hand: the cloud computer goes (here there is none to stop).
  await prisma.billingSubscription.update({ where: { id: comp.id }, data: { status: 'canceled' } })
  assert.equal(await billing.cloudEntitled(ws.plans!), false)
  await billing.planChanged(ws.plans!)
})

// --- Webhook -------------------------------------------------------------------------------

test("a forged event is refused; another product's changes nothing", { skip }, async () => {
  const forged = await billing.stripeWebhook(
    new Request('http://localhost:3001/api/billing/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 't=1,v1=forged' },
      body: '{}',
    }),
  )
  assert.equal(forged.status, 400)
  const papers = subscription({ customer: 'cus_papers' })
  fake.subscriptions.set(papers.id, papers)
  assert.equal((await deliver('customer.subscription.updated', papers)).status, 200)
  assert.equal(
    await prisma.billingSubscription.count({ where: { stripeSubscriptionId: papers.id } }),
    0,
  )
})

test("Stripe's webhook keeps the plan in step: canceling, then over", { skip }, async () => {
  await checkout(ws.webhook!)
  const [session] = await sessionsOf(ws.webhook!)
  const paid = pay(session!)
  assert.equal((await deliver('checkout.session.completed', completed(session!))).status, 200)
  assert.equal(await statusOf(ws.webhook!), 'active')

  // Canceled in the portal: it runs to the end of the period.
  Object.assign(paid, { cancel_at_period_end: true, cancel_at: now + 30 * 86400 })
  assert.equal((await deliver('customer.subscription.updated', paid)).status, 200)
  const plan = await billing.workspacePlan(ws.webhook!)
  assert.equal(plan?.cancelAtPeriodEnd, true)
  assert.equal(plan?.periodEnd?.getTime(), (now + 30 * 86400) * 1000)
  assert.equal(await billing.cloudEntitled(ws.webhook!), true)

  // The period is over: the workspace loses the cloud computer.
  Object.assign(paid, { status: 'canceled', ended_at: now })
  assert.equal((await deliver('customer.subscription.deleted', paid)).status, 200)
  assert.equal(await statusOf(ws.webhook!), 'canceled')
  assert.equal(await billing.cloudEntitled(ws.webhook!), false)
})

test(
  'a late, older event never brings a canceled plan back, Stripe reachable or not',
  { skip },
  async () => {
    await checkout(ws.late!)
    const [session] = await sessionsOf(ws.late!)
    const paid = pay(session!)
    const olderActive = structuredClone(paid)
    await deliver('checkout.session.completed', completed(session!))
    Object.assign(paid, { status: 'canceled', ended_at: now })
    await deliver('customer.subscription.deleted', paid)

    assert.equal((await deliver('customer.subscription.updated', olderActive)).status, 200)
    assert.equal(await statusOf(ws.late!), 'canceled')

    // Stripe cannot be read: nothing changes, and Stripe is asked to send it again.
    fake.failReads = 1
    assert.equal((await deliver('customer.subscription.updated', olderActive)).status, 503)
    assert.equal(await statusOf(ws.late!), 'canceled')
    assert.equal((await deliver('customer.subscription.updated', olderActive)).status, 200)
    assert.equal(await statusOf(ws.late!), 'canceled')
  },
)

test('overlapping events: the last read of Stripe is the one kept', { skip }, async () => {
  await checkout(ws.overlap!)
  const [session] = await sessionsOf(ws.overlap!)
  const paid = pay(session!)
  await deliver('checkout.session.completed', completed(session!))
  // A starts reading Stripe (active) and its answer is slow; meanwhile the plan is canceled,
  // and B reads that at once.
  fake.readDelaysMs = [300, 0]
  const a = deliver('customer.subscription.updated', paid)
  await new Promise((resolve) => setTimeout(resolve, 50))
  Object.assign(paid, { status: 'canceled', ended_at: now })
  const b = deliver('customer.subscription.deleted', paid)
  const answers = await Promise.all([a, b])
  assert.deepEqual(
    answers.map((r) => r.status),
    [200, 200],
  )
  assert.equal(await statusOf(ws.overlap!), 'canceled')
  assert.equal(await billing.cloudEntitled(ws.overlap!), false)
})

test(
  'a first completion Stripe cannot confirm is sent again, then the plan starts',
  { skip },
  async () => {
    await checkout(ws.firstRead!)
    const [session] = await sessionsOf(ws.firstRead!)
    pay(session!)
    fake.failReads = 1
    assert.equal((await deliver('checkout.session.completed', completed(session!))).status, 503)
    assert.equal(await billing.cloudEntitled(ws.firstRead!), false)
    // Stripe sends it again.
    assert.equal((await deliver('checkout.session.completed', completed(session!))).status, 200)
    assert.equal(await statusOf(ws.firstRead!), 'active')
    // One row: the one its Checkout was for.
    const rows = await prisma.billingSubscription.findMany({
      where: { workspaceId: ws.firstRead! },
    })
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.id, session!.metadata.rowId)
  },
)

// --- Checkout ------------------------------------------------------------------------------

test('one payable Checkout per workspace, even started twice at once', { skip }, async () => {
  await Promise.all([checkout(ws.checkout!), checkout(ws.checkout!)])
  assert.equal((await sessionsOf(ws.checkout!)).length, 1)
  // A third, later, by someone else: the one still open is expired first.
  await checkout(ws.checkout!, ids.member)
  assert.equal((await sessionsOf(ws.checkout!)).length, 1)
  assert.equal((await sessionsOf(ws.checkout!, 'expired')).length, 2)
  // All for one row, on the workspace's customer.
  const rows = await prisma.billingSubscription.findMany({ where: { workspaceId: ws.checkout! } })
  assert.equal(rows.length, 1)
  const customer = await billing.workspaceCustomerId(ws.checkout!)
  assert.equal(rows[0]!.stripeCustomerId, customer)
  for (const session of fake.sessions.filter((s) => s.customer === customer))
    assert.equal(session.metadata.rowId, rows[0]!.id)
})

test("whoever pays, the plan is the workspace's, on its own customer", { skip }, async () => {
  const customer = await billing.workspaceCustomerId(ws.checkout!)
  const [session] = await sessionsOf(ws.checkout!)
  // The member who started the last Checkout pays it, and comes back.
  const paid = pay(session!)
  await billing.checkoutReturn(session!.id)
  const plan = await billing.workspacePlan(ws.checkout!)
  assert.equal(plan?.status, 'active')
  assert.equal(plan?.stripeSubscriptionId, paid.id)
  assert.equal(plan?.stripeCustomerId, customer)
  await assert.rejects(checkout(ws.checkout!), /already has Brigade Cloud/)
})

test(
  'paid before its webhook came: no second Checkout, the payment is the plan',
  { skip },
  async () => {
    await checkout(ws.paid!)
    const [session] = await sessionsOf(ws.paid!)
    const made = fake.sessions.length
    // Paid in Stripe; the payer closed the tab, and the webhook is late.
    const paid = pay(session!)
    await assert.rejects(checkout(ws.paid!), /already has Brigade Cloud/)
    assert.equal(fake.sessions.length, made)
    const plan = await billing.workspacePlan(ws.paid!)
    assert.equal(plan?.stripeSubscriptionId, paid.id)
    assert.equal(plan?.id, session!.metadata.rowId)
    assert.equal(await billing.cloudEntitled(ws.paid!), true)
  },
)

test(
  "another workspace's plan, paid by the same person, has a customer of its own",
  { skip },
  async () => {
    await checkout(ws.elsewhere!)
    const here = await billing.workspaceCustomerId(ws.checkout!)
    const there = await billing.workspaceCustomerId(ws.elsewhere!)
    assert.ok(here && there)
    assert.notEqual(here, there)
    // A subscription that names another workspace is not taken for this one's.
    const [session] = await sessionsOf(ws.elsewhere!)
    const stray = subscription({ customer: there, metadata: { workspaceId: ws.checkout! } })
    fake.subscriptions.set(stray.id, stray)
    await deliver('checkout.session.completed', completed({ ...session!, subscription: stray.id }))
    assert.equal(await billing.cloudEntitled(ws.elsewhere!), false)
  },
)
