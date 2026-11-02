import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, describe, test } from 'node:test'
import pg from 'pg'

// A connection the database closed (src/db.ts): a read is run again on another, a write is not.
// Against the local database of apps/api/.env, whose connection is cut by pg_terminate_backend
// while a query runs; without a database to reach, those tests are skipped.
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

async function reachable() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  })
  try {
    await client.connect()
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}
const skip = (await reachable()) ? false : 'no database to reach (apps/api/.env DATABASE_URL)'

const { isDeadConnection, newPrismaClient, retryReads } = await import('../src/db.js')

describe('which errors are a closed connection', () => {
  test("node-postgres's, Hyperdrive's and Postgres's own", () => {
    assert.ok(isDeadConnection(new Error('Connection terminated unexpectedly')))
    const lost = Object.assign(new Error('Connection to the origin database was lost.'), {
      code: '08006',
    })
    assert.ok(isDeadConnection(lost))
    const shutdown = Object.assign(
      new Error('terminating connection due to administrator command'),
      {
        code: '57P01',
      },
    )
    assert.ok(isDeadConnection(shutdown))
    assert.ok(isDeadConnection(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })))
  })

  test("a query's own errors are not", () => {
    assert.ok(!isDeadConnection(Object.assign(new Error('duplicate key'), { code: '23505' })))
    assert.ok(!isDeadConnection(new Error('ORDER BY position 0 is not in select list')))
    assert.ok(!isDeadConnection('Connection terminated'))
  })
})

describe('retryReads', () => {
  /** A pool whose query fails `failures` times with `error`, then answers. */
  const pool = (failures: number, error: Error) => {
    const calls: unknown[] = []
    const fake = {
      query: async (config: unknown) => {
        calls.push(config)
        if (calls.length <= failures) throw error
        return { rows: [[1]] }
      },
    }
    retryReads(fake as unknown as pg.Pool)
    return { pool: fake as unknown as pg.Pool, calls }
  }
  const dropped = new Error('Connection terminated unexpectedly')

  test('a read that met a closed connection is run once more', async () => {
    const { pool: p, calls } = pool(1, dropped)
    assert.deepEqual(await p.query({ text: 'SELECT 1' }), { rows: [[1]] })
    assert.equal(calls.length, 2)
  })

  test('only once', async () => {
    const { pool: p, calls } = pool(2, dropped)
    await assert.rejects(p.query({ text: 'SELECT 1' }), /Connection terminated/)
    assert.equal(calls.length, 2)
  })

  test('a write is not: it may have been applied', async () => {
    const { pool: p, calls } = pool(2, dropped)
    await assert.rejects(p.query({ text: 'UPDATE "X" SET a = 1' }), /Connection terminated/)
    await assert.rejects(p.query({ text: 'INSERT INTO "X" VALUES (1)' }), /Connection terminated/)
    assert.equal(calls.length, 2)
  })

  test("a read's own error is not", async () => {
    const own = Object.assign(new Error('relation "X" does not exist'), { code: '42P01' })
    const { pool: p, calls } = pool(1, own)
    await assert.rejects(p.query({ text: 'SELECT * FROM "X"' }), /does not exist/)
    assert.equal(calls.length, 1)
  })
})

describe('a connection the database closes', { skip }, () => {
  const client = newPrismaClient(process.env.DATABASE_URL!, { max: 1 })
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL })
  after(async () => {
    await client.$disconnect()
    await admin.end().catch(() => {})
  })

  /** Cut the connection running `marker`'s query, as soon as it runs. */
  async function cut(marker: string) {
    for (let i = 0; i < 100; i++) {
      const { rowCount } = await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE pid <> pg_backend_pid() AND state = 'active' AND query LIKE $1`,
        [`%${marker}%`],
      )
      if (rowCount) return
      await new Promise((r) => setTimeout(r, 20))
    }
    throw new Error(`no query ${marker} to cut`)
  }

  test('a read on it is answered from another', async () => {
    await admin.connect()
    const marker = `read_${Date.now()}`
    const [rows] = await Promise.all([
      client.$queryRawUnsafe<{ ok: number }[]>(
        `SELECT 1 AS ok, '${marker}' AS m FROM pg_sleep(0.5)`,
      ),
      cut(marker),
    ])
    assert.deepEqual(
      rows.map((r) => r.ok),
      [1],
    )
    // The pool has dropped it: the next query works too.
    assert.equal((await client.$queryRawUnsafe<{ n: number }[]>('SELECT 2 AS n'))[0]?.n, 2)
  })

  test('a write on it fails, and is not run again', async () => {
    const marker = `write_${Date.now()}`
    await assert.rejects(
      Promise.all([
        client.$executeRawUnsafe(`DO $$ BEGIN PERFORM pg_sleep(0.5); PERFORM '${marker}'; END $$`),
        cut(marker),
      ]),
    )
    assert.equal((await client.$queryRawUnsafe<{ n: number }[]>('SELECT 3 AS n'))[0]?.n, 3)
  })
})
