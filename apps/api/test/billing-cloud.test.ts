import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import pg from 'pg'

// The cloud computer follows the workspace's plan (src/billing.ts, src/cloud.ts) even when the
// provider is slow or fails: a stop that fails is tried again, a computer still being made when
// the plan ends stops itself, and a row that says "running" resumes nothing without the plan.
// boat's API and Stripe are faked; the database is the local one of apps/api/.env, in an
// organization of its own removed at the end. Without a database to reach, it is skipped.
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
process.env.STRIPE_SECRET_KEY = 'sk_test_never_called'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_billing_cloud_test'
process.env.BOAT_API_KEY = 'test'

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

// boat, faked: what Brigade asked of it.
const { BoatApi } = createRequire(
  new URL('../../../packages/providers/package.json', import.meta.url),
)('@boatdev/sdk') as typeof import('@boatdev/sdk')
const boat = {
  stops: [] as string[],
  destroyed: new Set<string>(),
  /** The next destroys fail, as when boat does not answer. */
  failDestroys: 0,
  commands: 0,
  starts: 0,
  /** The next stops fail, as when boat does not answer. */
  failStops: 0,
  /** Holds sandbox creation until released. */
  creating: null as Promise<void> | null,
}
Object.assign(BoatApi.prototype, {
  create: async () => {
    await boat.creating
    return { sandbox: { id: `sb-${randomUUID().slice(0, 8)}` } }
  },
  update: async () => ({}),
  get: async ({ sandboxId }: { sandboxId: string }) => ({
    sandbox: { state: boat.destroyed.has(sandboxId) ? 'cancelled' : 'ready' },
  }),
  deleteSandbox: async ({ sandboxId }: { sandboxId: string }) => {
    if (boat.failDestroys > 0) {
      boat.failDestroys--
      throw new Error('boat did not answer')
    }
    boat.destroyed.add(sandboxId)
    return {}
  },
  stop: async ({ sandboxId }: { sandboxId: string }) => {
    if (boat.failStops > 0) {
      boat.failStops--
      throw new Error('boat did not answer')
    }
    boat.stops.push(sandboxId)
    return {}
  },
  resume: async () => {
    boat.starts++
    return {}
  },
  command: async () => {
    boat.commands++
    return { exitCode: 0, stdout: '', stderr: '' }
  },
})

const { prisma } = await import('../src/db.js')
const billing = await import('../src/billing.js')
const { createWorkspaceComputer, enforcePlans, ensureRunning, stopWithoutPlan } =
  await import('../src/cloud.js')

// Stripe, faked: its subscriptions as they are now.
const stripeNow = new Map<string, Record<string, unknown>>()
billing.stripeClient!.subscriptions.retrieve = (async (subscriptionId: string) =>
  structuredClone(stripeNow.get(subscriptionId))) as never

const now = Math.floor(Date.now() / 1000)
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
  return billing.stripeWebhook(
    new Request('http://localhost:3001/api/billing/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      body: payload,
    }),
  )
}

const id = randomUUID().slice(0, 8)
const organizationId = `org-billing-cloud-${id}`
const ws: Record<string, string> = {}

before(async () => {
  if (skip) return
  await prisma.organization.create({
    data: { id: organizationId, name: organizationId, slug: organizationId },
  })
  for (const name of ['stop', 'sweep', 'making', 'stale', 'strandedVm', 'cutShort'])
    ws[name] = (await prisma.workspace.create({ data: { organizationId, name } })).id
})

after(async () => {
  if (skip) return
  await prisma.organization.deleteMany({ where: { id: organizationId } })
  await prisma.$disconnect()
})

/** A workspace's plan, given by hand, and its cloud computer, running at boat with its runner. */
async function runningComputer(workspaceId: string, status = 'active') {
  await prisma.billingSubscription.create({
    data: { workspaceId, plan: 'cloud', status },
  })
  const computer = await prisma.computer.create({
    data: {
      organizationId,
      workspaceId,
      kind: 'cloud',
      name: 'Cloud computer',
      status: 'running',
      providerRef: { provider: 'boat', id: `sb-${workspaceId}` },
    },
  })
  await prisma.runner.create({
    data: { organizationId, workspaceId, computerId: computer.id, tokenHash: randomUUID() },
  })
  return computer
}

const statusOf = async (computerId: string) =>
  (await prisma.computer.findUniqueOrThrow({ where: { id: computerId } })).status

test('a stop that fails is not acknowledged: Stripe sends the event again', { skip }, async () => {
  const workspaceId = ws.stop!
  const computer = await runningComputer(workspaceId, 'incomplete')
  const subscription = {
    id: `sub_stop_${id}`,
    object: 'subscription',
    customer: `cus_stop_${id}`,
    status: 'canceled',
    cancel_at_period_end: false,
    cancel_at: null,
    canceled_at: now,
    ended_at: now,
    metadata: { workspaceId },
    items: { data: [{ current_period_start: now, current_period_end: now }] },
  }
  stripeNow.set(subscription.id, subscription)
  boat.failStops = 1
  assert.equal((await deliver('customer.subscription.deleted', subscription)).status, 503)
  assert.equal(await statusOf(computer.id), 'running')
  assert.equal((await deliver('customer.subscription.deleted', subscription)).status, 200)
  assert.equal(await statusOf(computer.id), 'stopped')
  assert.deepEqual(boat.stops, [`sb-${workspaceId}`])
})

test('the idle check stops a computer that runs without a plan', { skip }, async () => {
  const computer = await runningComputer(ws.sweep!, 'canceled')
  boat.failStops = 1
  await assert.rejects(stopWithoutPlan(computer), /boat did not answer/)
  assert.equal(await statusOf(computer.id), 'running')
  // A minute later.
  assert.equal(await stopWithoutPlan(computer), true)
  assert.equal(await statusOf(computer.id), 'stopped')
})

/** Wait for a computer to reach a status: its making runs in the background. */
async function until(computerId: string, status: string) {
  for (let i = 0; i < 100 && (await statusOf(computerId)) !== status; i++)
    await new Promise((resolve) => setTimeout(resolve, 20))
  return statusOf(computerId)
}

/** A workspace's cloud computer being made, held at boat until `release`, with its plan. */
async function beingMade(workspaceId: string) {
  const plan = await prisma.billingSubscription.create({
    data: { workspaceId, plan: 'cloud', status: 'active' },
  })
  let release!: () => void
  boat.creating = new Promise((resolve) => (release = resolve))
  const computer = (await createWorkspaceComputer({ id: workspaceId, organizationId }))!
  assert.equal(computer.status, 'creating')
  return { plan, computer, release }
}

test(
  'a computer being made when the plan ends goes once made; the next plan makes a new one',
  { skip },
  async () => {
    const workspaceId = ws.making!
    const { plan, computer, release } = await beingMade(workspaceId)
    // The plan ends while boat makes it: nothing to stop yet, and nothing fails.
    await prisma.billingSubscription.update({
      where: { id: plan.id },
      data: { status: 'canceled' },
    })
    const commandsBefore = boat.commands
    await billing.applyPlan(workspaceId)
    // Made: its VM goes, with nothing installed on it.
    release()
    boat.creating = null
    assert.equal(await until(computer.id, 'destroyed'), 'destroyed')
    const { providerRef } = await prisma.computer.findUniqueOrThrow({ where: { id: computer.id } })
    assert.ok(boat.destroyed.has((providerRef as { id: string }).id))
    assert.equal(boat.commands, commandsBefore)

    // Subscribed again: a new computer, made and installed.
    await prisma.billingSubscription.update({ where: { id: plan.id }, data: { status: 'active' } })
    await billing.applyPlan(workspaceId)
    const next = await prisma.computer.findFirstOrThrow({
      where: { workspaceId, kind: 'cloud', status: { not: 'destroyed' } },
    })
    assert.notEqual(next.id, computer.id)
    for (let i = 0; i < 100 && boat.commands === commandsBefore; i++)
      await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(boat.commands, commandsBefore + 1)
  },
)

test('a VM left up by a failed shutdown is shut down by the minute check', { skip }, async () => {
  const workspaceId = ws.strandedVm!
  const { plan, computer, release } = await beingMade(workspaceId)
  await prisma.billingSubscription.update({ where: { id: plan.id }, data: { status: 'canceled' } })
  // boat fails to destroy it once made: the computer is left in error, its VM up.
  boat.failDestroys = 1
  release()
  boat.creating = null
  assert.equal(await until(computer.id, 'error'), 'error')
  const { providerRef } = await prisma.computer.findUniqueOrThrow({ where: { id: computer.id } })
  assert.ok(!boat.destroyed.has((providerRef as { id: string }).id))
  // A minute later.
  await enforcePlans()
  assert.equal(await statusOf(computer.id), 'destroyed')
  assert.ok(boat.destroyed.has((providerRef as { id: string }).id))
})

test('a computer whose install was cut short is made again, not resumed', { skip }, async () => {
  const workspaceId = ws.cutShort!
  await prisma.billingSubscription.create({
    data: { workspaceId, plan: 'cloud', status: 'active' },
  })
  // Its VM exists, stopped, but its runner was never installed (no Runner).
  const computer = await prisma.computer.create({
    data: {
      organizationId,
      workspaceId,
      kind: 'cloud',
      name: 'Cloud computer',
      status: 'stopped',
      providerRef: { provider: 'boat', id: `sb-cut-${id}` },
    },
  })
  const startsBefore = boat.starts
  const commandsBefore = boat.commands
  await ensureRunning(computer.id)
  for (let i = 0; i < 100 && boat.commands === commandsBefore; i++)
    await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(boat.starts, startsBefore)
  assert.ok(boat.destroyed.has(`sb-cut-${id}`))
  assert.equal(boat.commands, commandsBefore + 1)
  const { providerRef } = await prisma.computer.findUniqueOrThrow({ where: { id: computer.id } })
  assert.notEqual((providerRef as { id: string }).id, `sb-cut-${id}`)
})

test('a row that says "running" resumes nothing without the plan', { skip }, async () => {
  const computer = await runningComputer(ws.stale!, 'canceled')
  const startsBefore = boat.starts
  await assert.rejects(ensureRunning(computer.id), (error: unknown) => {
    assert.equal((error as { status?: number }).status, 402)
    return true
  })
  assert.equal(boat.starts, startsBefore)
})
