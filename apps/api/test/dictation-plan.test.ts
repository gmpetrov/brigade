import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import pg from 'pg'

// Dictation comes with Brigade Cloud (src/dictation.ts): with billing on and no plan, the
// microphone says so and a recording is refused with 402 before it reaches Groq; with the plan,
// it records. Against the local database of apps/api/.env, in an organization of its own
// removed at the end; without a database to reach, the tests are skipped.
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
// Billing on, with keys that reach nothing: nothing here calls Stripe or Groq.
process.env.STRIPE_SECRET_KEY = 'sk_test_never_called'
process.env.GROQ_API_KEY = 'gsk_test_never_sent'

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

const { prisma } = await import('../src/db.js')
const dictation = await import('../src/dictation.js')
const { HTTPException } = await import('hono/http-exception')

const id = randomUUID().slice(0, 8)
const org = `org-dictation-${id}`
let workspaceId: string

before(async () => {
  if (skip) return
  await prisma.organization.create({ data: { id: org, name: 'Dictation', slug: org } })
  const workspace = await prisma.workspace.create({
    data: { organizationId: org, name: 'Dictation' },
  })
  workspaceId = workspace.id
})

after(async () => {
  if (skip) return
  await prisma.organization.deleteMany({ where: { id: org } })
  await prisma.$disconnect()
})

test(
  'without the plan, the microphone asks for Brigade Cloud and records nothing',
  { skip },
  async () => {
    assert.deepEqual(await dictation.dictationStatus(workspaceId), {
      available: false,
      reason: 'plan',
    })
    await assert.rejects(dictation.requireDictation(workspaceId), (error: unknown) => {
      assert.ok(error instanceof HTTPException)
      assert.equal(error.status, 402)
      assert.equal(error.message, dictation.DICTATION_PLAN_REQUIRED)
      return true
    })
  },
)

test('with the plan, it records', { skip }, async () => {
  // Complimentary: active, with no Stripe subscription behind it.
  await prisma.billingSubscription.create({
    data: { workspaceId, plan: 'cloud', status: 'active' },
  })
  assert.deepEqual(await dictation.dictationStatus(workspaceId), { available: true })
  await dictation.requireDictation(workspaceId)
})
