import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import pg from 'pg'

// Brigade Cloud Starter (src/billing.ts PLANS): its tier follows the subscription's price, its
// Checkout uses its own price, and its cloud computer runs only while the period's hours last.
// Email and dictation stay; threads' own machines do not come with it. Stripe is faked where
// billing calls it. The database parts run against the local one of apps/api/.env (or
// DATABASE_URL), in an organization of their own removed at the end; without one, skipped.
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
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_billing_starter_test'
// A dictation provider, so only the plan decides whether it is there.
process.env.GROQ_API_KEY = 'gsk_never_called'

async function reachable() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  })
  try {
    await client.connect()
    await client.query('select "tier" from "BillingSubscription" limit 1')
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
const { dictationStatus, requireDictation } = await import('../src/dictation.js')
const { HTTPException } = await import('hono/http-exception')

test('a price is Starter only by its own lookup key', () => {
  assert.equal(billing.tierOfPrice('brigade_cloud_starter_monthly'), 'starter')
  assert.equal(billing.tierOfPrice('brigade_cloud_monthly'), 'cloud')
  assert.equal(billing.tierOfPrice(null), 'cloud')
  assert.equal(billing.PLANS.starter.hours, 100)
})

// --- Stripe, faked -------------------------------------------------------------------------

const stripe = billing.stripeClient!
const now = Math.floor(Date.now() / 1000)
const prices = {
  cloud: { id: 'price_cloud', lookup_key: 'brigade_cloud_monthly' },
  starter: { id: 'price_starter', lookup_key: 'brigade_cloud_starter_monthly' },
}
type Fake = Record<string, any>
const fake = {
  subscriptions: new Map<string, Fake>(),
  sessions: [] as Fake[],
  /** The lookup keys prices were asked for, in order. */
  looked: [] as string[],
  portals: [] as Fake[],
}
stripe.subscriptions.retrieve = (async (subscriptionId: string) =>
  structuredClone(fake.subscriptions.get(subscriptionId))) as never
stripe.subscriptions.list = ((params: { customer: string }) =>
  (async function* () {
    for (const subscription of fake.subscriptions.values())
      if (subscription.customer === params.customer) yield structuredClone(subscription)
  })()) as never
stripe.customers.create = (async (params: Fake) => ({
  id: `cus_${randomUUID().slice(0, 8)}`,
  ...params,
})) as never
stripe.prices.list = (async (params: { lookup_keys: string[] }) => {
  fake.looked.push(...params.lookup_keys)
  return {
    data: Object.values(prices).filter((p) => params.lookup_keys.includes(p.lookup_key)),
  }
}) as never
stripe.checkout.sessions.list = ((params: { customer: string; status: string }) =>
  (async function* () {
    for (const session of fake.sessions)
      if (session.customer === params.customer && session.status === params.status) yield session
  })()) as never
stripe.checkout.sessions.create = (async (params: Fake) => {
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
stripe.billingPortal.configurations.list = (async () => ({
  data: [{ id: 'bpc_brigade', metadata: { brigade: 'portal' } }],
})) as never
stripe.billingPortal.sessions.create = (async (params: Fake) => {
  fake.portals.push(params)
  return { id: 'bps_1', url: 'https://portal.test/upgrade' }
}) as never

/** A Stripe subscription of the workspace, on `price`, as Stripe would have it. */
const subscription = (workspaceId: string, customer: string, price: Fake): Fake => ({
  id: `sub_${randomUUID().slice(0, 8)}`,
  object: 'subscription',
  status: 'active',
  customer,
  cancel_at_period_end: false,
  cancel_at: null,
  canceled_at: null,
  ended_at: null,
  start_date: now,
  metadata: { workspaceId },
  items: {
    data: [
      {
        id: `si_${randomUUID().slice(0, 8)}`,
        quantity: 1,
        current_period_start: now - 10 * 86400,
        current_period_end: now + 20 * 86400,
        price,
      },
    ],
  },
})

// --- Fixtures ------------------------------------------------------------------------------

const id = randomUUID().slice(0, 8)
const organizationId = `org-billing-starter-${id}`
const ownerId = `user-billing-starter-${id}`
const ws: Record<string, string> = {}

before(async () => {
  if (skip) return
  billing.forgetPortalConfiguration()
  await prisma.organization.create({
    data: { id: organizationId, name: organizationId, slug: organizationId },
  })
  await prisma.user.create({
    data: { id: ownerId, name: ownerId, email: `${ownerId}@example.com` },
  })
  for (const name of [
    'checkout',
    'tier',
    'hours',
    'period',
    'upgrade',
    'features',
    'held',
    'max',
    'machines',
  ])
    ws[name] = (await prisma.workspace.create({ data: { organizationId, name } })).id
})

after(async () => {
  if (skip) return
  await prisma.organization.deleteMany({ where: { id: organizationId } })
  await prisma.user.deleteMany({ where: { id: ownerId } })
  await prisma.$disconnect()
})

/** A Starter plan on the workspace, its period [periodStart, periodEnd), with no Stripe behind it. */
const starterRow = (workspaceId: string, periodStart: Date, periodEnd: Date) =>
  prisma.billingSubscription.create({
    data: { workspaceId, plan: 'cloud', tier: 'starter', status: 'active', periodStart, periodEnd },
  })

const HOUR = 3_600_000

/** A run of the workspace's cloud computer (or a thread's machine) from `from`, `hours` long. */
const run = (
  workspaceId: string,
  from: Date,
  hours: number | null,
  fields: { kind?: 'computer' | 'machine'; status?: 'open' | 'closed' | 'void' } = {},
) =>
  prisma.vmRun.create({
    data: {
      organizationId,
      workspaceId,
      kind: fields.kind ?? 'computer',
      size: fields.kind === 'machine' ? '8x16' : '4x8',
      start: 'resume',
      status: fields.status ?? (hours === null ? 'open' : 'closed'),
      startedAt: from,
      stoppedAt: hours === null ? null : new Date(from.getTime() + hours * HOUR),
    },
  })

// --- Tests ---------------------------------------------------------------------------------

test("Starter's Checkout is for Starter's price", { skip }, async () => {
  fake.looked.length = 0
  const url = await billing.startCheckout({
    workspaceId: ws.checkout!,
    user: { id: ownerId, email: `${ownerId}@example.com` },
    from: 'billing',
    cancelUrl: 'http://localhost:3000/app/billing',
    tier: 'starter',
  })
  assert.match(url, /^https:\/\/checkout\.test\//)
  assert.deepEqual(fake.looked, ['brigade_cloud_starter_monthly'])
  const session = fake.sessions.at(-1)!
  assert.deepEqual(session.line_items, [{ price: 'price_starter', quantity: 1 }])
})

test('the tier follows the price: Starter, then Cloud once switched', { skip }, async () => {
  const workspaceId = ws.tier!
  const customer = `cus_tier_${id}`
  const subscribed = subscription(workspaceId, customer, prices.starter)
  fake.subscriptions.set(subscribed.id, subscribed)
  await billing.reconcile({ workspaceId, subscriptionId: subscribed.id })
  assert.equal((await billing.workspacePlan(workspaceId))?.tier, 'starter')
  assert.deepEqual(await billing.planOf(workspaceId).then((p) => [p.entitled, p.tier]), [
    true,
    'starter',
  ])
  // Upgraded in the portal: the same subscription, on Cloud's price.
  subscribed.items.data[0].price = prices.cloud
  await billing.reconcile({ workspaceId, subscriptionId: subscribed.id })
  const rows = await prisma.billingSubscription.findMany({ where: { workspaceId } })
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.tier, 'cloud')
})

test("Starter's computer runs while its period's hours last", { skip }, async () => {
  const workspaceId = ws.hours!
  const at = new Date()
  const periodStart = new Date(at.getTime() - 10 * 24 * HOUR)
  const periodEnd = new Date(at.getTime() + 20 * 24 * HOUR)
  await starterRow(workspaceId, periodStart, periodEnd)
  // Before the period: not counted. A thread's machine, or a void run: not the computer's hours.
  await run(workspaceId, new Date(periodStart.getTime() - 50 * HOUR), 45)
  await run(workspaceId, new Date(periodStart.getTime() + HOUR), 60, { kind: 'machine' })
  await run(workspaceId, new Date(periodStart.getTime() + HOUR), 60, { status: 'void' })
  // A run across the period's start counts from it: 2 hours of its 4.
  await run(workspaceId, new Date(periodStart.getTime() - 2 * HOUR), 4)
  await run(workspaceId, new Date(periodStart.getTime() + 24 * HOUR), 90)
  let usage = await billing.starterUsage(workspaceId, { periodStart, periodEnd }, at)
  assert.ok(Math.abs(usage.usedHours - 92) < 0.01, `used ${usage.usedHours}`)
  assert.equal(usage.includedHours, 100)
  assert.equal(usage.resetsAt.getTime(), periodEnd.getTime())
  assert.deepEqual(await billing.cloudAccess(workspaceId, at), { ok: true })
  assert.equal(await billing.cloudEntitled(workspaceId), true)

  // Running now, past the hundredth hour: the computer may not run any more.
  await run(workspaceId, new Date(at.getTime() - 9 * HOUR), null)
  usage = await billing.starterUsage(workspaceId, { periodStart, periodEnd }, at)
  assert.ok(usage.usedHours >= 100, `used ${usage.usedHours}`)
  const access = await billing.cloudAccess(workspaceId, at)
  assert.equal(access.ok, false)
  assert.equal(!access.ok && access.reason, 'hours')
  assert.equal(
    !access.ok && access.reason === 'hours' && access.resetsAt.getTime(),
    periodEnd.getTime(),
  )
  assert.equal(await billing.cloudEntitled(workspaceId), false)
  await assert.rejects(billing.requireCloudPlan(workspaceId), (error: unknown) => {
    assert.ok(error instanceof HTTPException)
    assert.equal(error.status, 402)
    assert.match(error.message, /100 cloud computer hours of Starter are used up/)
    return true
  })
  // Its plan still stands: email keeps working.
  assert.equal(await billing.planEntitled(workspaceId), true)
  await billing.requireEmailPlan(workspaceId)
})

test('on Brigade Cloud, hours never stop the computer', { skip }, async () => {
  const workspaceId = ws.period!
  await prisma.billingSubscription.create({
    data: { workspaceId, plan: 'cloud', status: 'active' },
  })
  await run(workspaceId, new Date(Date.now() - 500 * HOUR), null)
  assert.deepEqual(await billing.cloudAccess(workspaceId), { ok: true })
})

test('without a period Stripe gave, the calendar month counts', { skip }, async () => {
  const at = new Date(Date.UTC(2026, 10, 17, 12))
  const usage = await billing.starterUsage(ws.period!, { periodStart: null, periodEnd: null }, at)
  assert.equal(usage.resetsAt.toISOString(), '2026-12-01T00:00:00.000Z')
  // A stale period (a renewal not read yet): the calendar month too.
  const stale = await billing.starterUsage(
    ws.period!,
    { periodStart: new Date(Date.UTC(2026, 8, 1)), periodEnd: new Date(Date.UTC(2026, 9, 1)) },
    at,
  )
  assert.equal(stale.resetsAt.toISOString(), '2026-12-01T00:00:00.000Z')
})

test("the upgrade opens the portal's confirmation of Cloud's price", { skip }, async () => {
  const workspaceId = ws.upgrade!
  const customer = `cus_upgrade_${id}`
  await prisma.workspace.update({
    where: { id: workspaceId },
    data: { stripeCustomerId: customer },
  })
  const subscribed = subscription(workspaceId, customer, prices.starter)
  fake.subscriptions.set(subscribed.id, subscribed)
  await billing.reconcile({ workspaceId, subscriptionId: subscribed.id })
  const url = await billing.startUpgrade(
    workspaceId,
    'http://localhost:3000/app/billing?upgraded=1',
  )
  assert.equal(url, 'https://portal.test/upgrade')
  const portal = fake.portals.at(-1)!
  assert.equal(portal.customer, customer)
  assert.equal(portal.configuration, 'bpc_brigade')
  assert.equal(portal.flow_data.type, 'subscription_update_confirm')
  assert.deepEqual(portal.flow_data.subscription_update_confirm, {
    subscription: subscribed.id,
    items: [{ id: subscribed.items.data[0].id, price: 'price_cloud', quantity: 1 }],
  })
  // Once on Cloud, there is nothing to upgrade.
  subscribed.items.data[0].price = prices.cloud
  await billing.reconcile({ workspaceId, subscriptionId: subscribed.id })
  await assert.rejects(
    billing.startUpgrade(workspaceId, 'http://localhost:3000/app/billing'),
    (error: unknown) => error instanceof HTTPException && error.status === 409,
  )
})

test('dictation comes with Starter too, whatever its hours', { skip }, async () => {
  const workspaceId = ws.features!
  await starterRow(
    workspaceId,
    new Date(Date.now() - 10 * 24 * HOUR),
    new Date(Date.now() + 20 * 24 * HOUR),
  )
  assert.deepEqual(await dictationStatus(workspaceId), { available: true })
  await requireDictation(workspaceId)
  // Its hours used up: the cloud computer sleeps, dictation stays.
  await run(workspaceId, new Date(Date.now() - 5 * 24 * HOUR), 101)
  assert.equal(await billing.cloudEntitled(workspaceId), false)
  assert.deepEqual(await dictationStatus(workspaceId), { available: true })
})

// --- Work waiting while the hours are used up ----------------------------------------------

/** A thread of the workspace on its cloud computer, the owner's, with a Riley of its own. */
async function cloudThread(workspaceId: string) {
  const memberId = `member-${organizationId}`
  await prisma.member.upsert({
    where: { id: memberId },
    create: { id: memberId, organizationId, userId: ownerId, role: 'owner' },
    update: {},
  })
  const teammate = await prisma.teammate.create({
    data: { organizationId, workspaceId, name: 'Riley' } as never,
  })
  const computer = await prisma.computer.create({
    data: { organizationId, workspaceId, kind: 'cloud', name: 'Cloud', status: 'stopped' },
  })
  const session = await prisma.session.create({
    data: {
      organizationId,
      workspaceId,
      teammateId: teammate.id,
      startedByMemberId: memberId,
      computerId: computer.id,
      title: 'A thread',
      status: 'idle',
      lastSeq: 0,
    } as never,
  })
  return { computerId: computer.id, sessionId: session.id }
}

/** A message for the thread, waiting since `at` for its computer. */
const waiting = (
  workspaceId: string,
  thread: { computerId: string; sessionId: string },
  at: Date,
) =>
  prisma.runnerCommand.create({
    data: {
      id: randomUUID(),
      organizationId,
      workspaceId,
      computerId: thread.computerId,
      sessionId: thread.sessionId,
      type: 'thread.prompt',
      message: { type: 'thread.prompt', text: 'Go on', memberId: null } as never,
      createdAt: at,
    },
  })

const statusOf = async (commandId: string) =>
  (await prisma.runnerCommand.findUniqueOrThrow({ where: { id: commandId } })).status

test(
  "work waiting while Starter's hours are used up is kept, then given up a day after",
  { skip },
  async () => {
    const { giveUp } = await import('../src/runner-commands.js')
    const workspaceId = ws.held!
    const t0 = Date.now()
    const plan = await starterRow(
      workspaceId,
      new Date(t0 - 10 * 24 * HOUR),
      new Date(t0 + 20 * 24 * HOUR),
    )
    await run(workspaceId, new Date(t0 - 9 * 24 * HOUR), 101)
    const thread = await cloudThread(workspaceId)
    // Sent 30 hours ago, on day 5 of a pause that lasts weeks.
    const command = await waiting(workspaceId, thread, new Date(t0 - 30 * HOUR))
    await giveUp(t0)
    assert.equal(await statusOf(command.id), 'pending', 'kept while the hours are used up')
    const computer = await prisma.computer.findUniqueOrThrow({ where: { id: thread.computerId } })
    assert.equal(computer.hoursHeldAt?.getTime(), t0)
    await giveUp(t0 + 6 * 24 * HOUR)
    assert.equal(await statusOf(command.id), 'pending', 'kept for as long as the pause lasts')

    // Upgraded to Max (or the hours came back): the computer may run, and the minute's resend
    // starts it. Its commands get a day for it before they are given up.
    await prisma.billingSubscription.update({ where: { id: plan.id }, data: { tier: 'cloud' } })
    await giveUp(t0 + 6 * 24 * HOUR + 60_000)
    assert.equal(await statusOf(command.id), 'pending', 'not given up the minute the pause ends')
    await giveUp(t0 + 7 * 24 * HOUR + 60_000)
    assert.equal(await statusOf(command.id), 'failed', 'given up a day after the pause ended')
    const ticket = await prisma.ticket.findFirst({ where: { sessionId: thread.sessionId } })
    assert.ok(ticket, 'with a ticket in its thread')
  },
)

test("work waiting for Max's cloud computer is still given up after a day", { skip }, async () => {
  const { giveUp } = await import('../src/runner-commands.js')
  const workspaceId = ws.max!
  const t0 = Date.now()
  await prisma.billingSubscription.create({
    data: {
      workspaceId,
      plan: 'cloud',
      tier: 'cloud',
      status: 'active',
      periodStart: new Date(t0 - 10 * 24 * HOUR),
      periodEnd: new Date(t0 + 20 * 24 * HOUR),
    },
  })
  await run(workspaceId, new Date(t0 - 9 * 24 * HOUR), 101)
  const thread = await cloudThread(workspaceId)
  const command = await waiting(workspaceId, thread, new Date(t0 - 25 * HOUR))
  await giveUp(t0)
  assert.equal(await statusOf(command.id), 'failed')
  const computer = await prisma.computer.findUniqueOrThrow({ where: { id: thread.computerId } })
  assert.equal(computer.hoursHeldAt, null)
})

test(
  "a thread's machine in use is put to sleep once the workspace is on Starter",
  { skip },
  async () => {
    const { machineTouch } = await import('../src/preview-machines.js')
    const workspaceId = ws.machines!
    await starterRow(
      workspaceId,
      new Date(Date.now() - 10 * 24 * HOUR),
      new Date(Date.now() + 20 * 24 * HOUR),
    )
    const thread = await cloudThread(workspaceId)
    // Made while the workspace was on Max, its preview still in use.
    await prisma.previewMachine.create({
      data: {
        organizationId,
        workspaceId,
        sessionId: thread.sessionId,
        status: 'running',
        providerRef: { provider: 'boat', id: 'vm-starter-machine' },
        keptAliveAt: new Date(Date.now() - HOUR),
      },
    })
    const calls = { stopped: [] as string[], keptAlive: [] as string[] }
    const machines = {
      stop: async (ref: { id: string }) => void calls.stopped.push(ref.id),
      keepAlive: async (ref: { id: string }) => void calls.keptAlive.push(ref.id),
    }
    await machineTouch(machines as never, { computerId: thread.computerId }, thread.sessionId)
    assert.deepEqual(calls, { stopped: ['vm-starter-machine'], keptAlive: [] })
    const machine = await prisma.previewMachine.findUniqueOrThrow({
      where: { sessionId: thread.sessionId },
    })
    assert.equal(machine.status, 'stopped')
  },
)
