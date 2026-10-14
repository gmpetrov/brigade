import { defineConfig, env } from 'prisma/config'

try {
  process.loadEnvFile('.env')
} catch {
  // no .env: use the process environment
}

/**
 * The CLI migrates through the database's direct endpoint. Migrations take a session lock
 * (pg_advisory_lock), and through a transaction pooler such as Neon's `-pooler` endpoint
 * a pooled connection can keep it, blocking every later migration. The API itself keeps
 * the pooler (src/db.ts).
 */
function direct(url: string) {
  const parsed = new URL(url)
  parsed.hostname = parsed.hostname.replace('-pooler.', '.')
  return parsed.toString()
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: direct(env('DATABASE_URL')) },
})
