import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import pg from 'pg'

// Brigade's own email addresses come with Brigade Cloud (src/billing.ts requireEmailPlan): with
// billing on and no plan, turning an address on and sending are refused; with the plan, they
// go on. Against the local database of apps/api/.env, in an organization of its own removed at
// the end; without a database to reach, the tests are skipped.
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
// Billing on, with a key that reaches nothing: nothing here calls Stripe.
process.env.STRIPE_SECRET_KEY = 'sk_test_never_called'
process.env.MAIL_DOMAIN = 'mails.brigade.test'

async function reachable() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  })
  try {
    await client.connect()
    await client.query('select 1 from "BillingSubscription" limit 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}
const skip = (await reachable()) ? false : 'no database to reach (apps/api/.env DATABASE_URL)'

const { prisma, scoped } = await import('../src/db.js')
const billing = await import('../src/billing.js')
const outbound = await import('../src/mail/outbound.js')
const { HTTPException } = await import('hono/http-exception')

const id = randomUUID().slice(0, 8)
const org = `org-mail-plan-${id}`
const user = `user-mail-plan-${id}`
const member = `mem-mail-plan-${id}`
let scope: { organizationId: string; workspaceId: string }
let address: Awaited<ReturnType<typeof prisma.mailAddress.create>>
let thread: { id: string; projectId: null; teammateId: string; origin: string; status: string }

before(async () => {
  if (skip) return
  await prisma.organization.create({ data: { id: org, name: 'Mail plan', slug: org } })
  await prisma.user.create({ data: { id: user, name: 'Ada', email: `ada-${id}@plan.test` } })
  await prisma.member.create({
    data: { id: member, organizationId: org, userId: user, role: 'owner' },
  })
  const workspace = await prisma.workspace.create({
    data: { organizationId: org, name: 'Mail plan' },
  })
  scope = { organizationId: org, workspaceId: workspace.id }
  const teammate = await prisma.teammate.create({ data: { ...scope, name: `Riley ${id}` } })
  address = await prisma.mailAddress.create({
    data: {
      ...scope,
      name: `riley-plan-${id}`,
      kind: 'agent',
      teammateId: teammate.id,
      createdByMemberId: member,
    },
  })
  thread = {
    id: `thread-${id}`,
    projectId: null,
    teammateId: teammate.id,
    origin: 'member',
    status: 'running',
  }
})

after(async () => {
  if (skip) return
  await prisma.mailAddress.deleteMany({ where: { organizationId: org } })
  await prisma.organization.deleteMany({ where: { id: org } })
  await prisma.user.deleteMany({ where: { id: user } })
  await prisma.$disconnect()
})

const draft = { to: ['someone@outside.test'], subject: 'Hello', text: 'Hi there' }

test('without the plan, no address and no mail out', { skip }, async () => {
  await assert.rejects(billing.requireEmailPlan(scope.workspaceId), (error: unknown) => {
    assert.ok(error instanceof HTTPException)
    assert.equal(error.status, 402)
    assert.equal(error.message, billing.EMAIL_PLAN_REQUIRED)
    return true
  })
  const db = scoped(scope)
  const problem = await outbound.checkDraft(db, { address, thread, draft })
  assert.ok(problem?.startsWith(billing.EMAIL_PLAN_REQUIRED), String(problem))
  assert.match(problem!, /tell the person/)
  // A person replying from the Inbox is told, not asked to tell someone.
  const own = await outbound.checkDraft(db, { address, thread, draft, byPerson: true })
  assert.ok(own?.startsWith(billing.EMAIL_PLAN_REQUIRED), String(own))
  assert.doesNotMatch(own!, /tell the person/)
})

test('with the plan, the address turns on and mail goes', { skip }, async () => {
  // Complimentary: active, with no Stripe subscription behind it.
  await prisma.billingSubscription.create({
    data: { workspaceId: scope.workspaceId, plan: 'cloud', status: 'active' },
  })
  await billing.requireEmailPlan(scope.workspaceId)
  const problem = await outbound.checkDraft(scoped(scope), { address, thread, draft })
  assert.equal(problem, null)
})
