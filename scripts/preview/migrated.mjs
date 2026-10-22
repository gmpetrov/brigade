// Whether the API's database has every migration in apps/api/prisma/migrations applied and
// none failed, asked of the database itself (it may have been reset since): then setup.sh
// skips `prisma migrate deploy`, which takes seconds to find nothing to do. Exits 0 when so,
// 1 otherwise or when it cannot tell: deploy then runs, and says what is wrong.
import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const api = fileURLToPath(new URL('../../apps/api/', import.meta.url))
const migrations = join(api, 'prisma/migrations')
try {
  process.loadEnvFile(join(api, '.env'))
} catch {
  // no .env: the process environment's DATABASE_URL
}
// pg is the API's dependency, not the repository's.
const { Client } = createRequire(join(api, 'package.json'))('pg')

const wanted = readdirSync(migrations, { withFileTypes: true })
  .filter(
    (entry) => entry.isDirectory() && existsSync(join(migrations, entry.name, 'migration.sql')),
  )
  .map((entry) => entry.name)
const client = new Client({ connectionString: process.env.DATABASE_URL })
try {
  await client.connect()
  const { rows } = await client.query(
    'SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations',
  )
  const applied = new Set(
    rows.filter((row) => row.finished_at && !row.rolled_back_at).map((row) => row.migration_name),
  )
  // One that failed and was not resolved: deploy stops on it, and says so.
  const failed = rows.some((row) => !row.finished_at && !row.rolled_back_at)
  process.exitCode = !failed && wanted.every((name) => applied.has(name)) ? 0 : 1
} catch {
  // No database, or none migrated yet (no _prisma_migrations).
  process.exitCode = 1
} finally {
  await client.end().catch(() => undefined)
}
