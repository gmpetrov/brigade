// PostgreSQL without Docker, for previews: the embedded-postgres package from
// the cache (PG_PACKAGE), with docker-compose.yml's user, password and database.
// Runs until stopped.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const { PG_PACKAGE, PG_DATA, PG_PORT } = process.env
const { default: EmbeddedPostgres } = await import(
  pathToFileURL(join(PG_PACKAGE, 'dist/index.js')).href
)

const pg = new EmbeddedPostgres({
  databaseDir: PG_DATA,
  port: Number(PG_PORT),
  user: 'brigade',
  password: 'brigade',
  persistent: true,
  onLog: () => {},
})
if (!existsSync(join(PG_DATA, 'PG_VERSION'))) await pg.initialise()
await pg.start()
const client = pg.getPgClient()
await client.connect()
const { rowCount } = await client.query("SELECT 1 FROM pg_database WHERE datname = 'brigade'")
await client.end()
if (!rowCount) await pg.createDatabase('brigade')
console.log(`PostgreSQL on port ${PG_PORT}`)

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.on(signal, () => void pg.stop().finally(() => process.exit(0)))
setInterval(() => {}, 1 << 30)
