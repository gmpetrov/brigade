import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PrismaPg } from '@prisma/adapter-pg'
import pg from 'pg'

// What a new PrismaClient holds (patches/@prisma__client@7.10.1.patch). Prisma's runtime decodes
// the schema's parameterization graph for each client it makes: about 17 MB of the heap with
// Brigade's schema. The Worker makes a client for each queue batch, cron run and read it
// serves (src/worker.ts, stateless), and a workspace's hub makes one each time it wakes;
// Cloudflare runs many of them in one isolate of 128 MB, and on Nov 4 2026, 10 queue batches
// at once ran it out of memory (exceededMemory). With the patch, the graph is decoded once per
// schema and shared: a client after the first costs little more than its pool.

const DATABASE_URL = 'postgresql://nobody@127.0.0.1:1/none'
process.env.DATABASE_URL ??= DATABASE_URL
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')

type Client = { $disconnect(): Promise<void> }
type ClientClass = new (options: { adapter: PrismaPg }) => Client

/** The heap each client made after the first holds, in MB: the mean of `count` of them. */
async function heapPerClient(PrismaClient: ClientClass, count = 4) {
  const make = () =>
    new PrismaClient({ adapter: new PrismaPg(new pg.Pool({ connectionString: DATABASE_URL })) })
  const clients = [make()]
  global.gc!()
  const before = process.memoryUsage().heapUsed
  for (let i = 0; i < count; i++) clients.push(make())
  global.gc!()
  const after = process.memoryUsage().heapUsed
  // Kept alive until measured: what they hold is what is counted.
  assert.equal(clients.length, count + 1)
  await Promise.all(clients.map((c) => c.$disconnect().catch(() => undefined)))
  return (after - before) / count / 1e6
}

const skip = !global.gc && 'needs --expose-gc'

test('a new Node client shares the decoded schema of the others', { skip }, async () => {
  const { PrismaClient } = await import('../src/generated/prisma/client.js')
  const mb = await heapPerClient(PrismaClient as unknown as ClientClass)
  assert.ok(mb < 2, `each new client holds ${mb.toFixed(1)} MB of the heap (17 MB unpatched)`)
})

test("a new Workers client (the Worker's and hubs') shares it too", { skip }, async () => {
  const { PrismaClient } = await import('../src/generated/prisma-workers/client.js')
  const mb = await heapPerClient(PrismaClient as unknown as ClientClass)
  assert.ok(mb < 2, `each new client holds ${mb.toFixed(1)} MB of the heap (17 MB unpatched)`)
})
