// The database operations reset.sh needs, through the API's own DATABASE_URL (apps/api/.env),
// on the maintenance database of the same server. Local databases only.
//   node database.mjs url <name>          the API's URL with another database name
//   node database.mjs exists <name>       exits 0 when it exists, 1 otherwise
//   node database.mjs create <name>       an empty one, after dropping any of that name
//   node database.mjs drop <name>
//   node database.mjs drop-prefix <prefix> [<keep>]   every one named <prefix>…, except <keep>
//   node database.mjs rename <from> <to>
//   node database.mjs restore <template>  the API's database again, as a copy of <template>
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const api = fileURLToPath(new URL('../../apps/api/', import.meta.url))
try {
  process.loadEnvFile(join(api, '.env'))
} catch {
  // no .env: the process environment's DATABASE_URL
}
const base = new URL(process.env.DATABASE_URL ?? '')
if (!/^(localhost|127\.0\.0\.1)$/.test(base.hostname)) {
  console.error(`Refusing to touch a database that is not local (${base.hostname})`)
  process.exit(2)
}
const own = decodeURIComponent(base.pathname.slice(1))
const withName = (name) => Object.assign(new URL(base), { pathname: `/${name}` }).toString()
const quote = (name) => `"${name.replaceAll('"', '""')}"`

const [command, name, extra] = process.argv.slice(2)
if (command === 'url') {
  console.log(withName(name))
  process.exit(0)
}

// pg is the API's dependency, not the repository's.
const { Client } = createRequire(join(api, 'package.json'))('pg')
const client = new Client({ connectionString: withName('postgres') })
await client.connect()
const exists = async (db) =>
  (await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [db])).rowCount > 0
// FORCE ends the connections to it (the API's, a seed's) in the same statement.
const drop = (db) => client.query(`DROP DATABASE IF EXISTS ${quote(db)} WITH (FORCE)`)
try {
  switch (command) {
    case 'exists':
      process.exitCode = (await exists(name)) ? 0 : 1
      break
    case 'create':
      await drop(name)
      await client.query(`CREATE DATABASE ${quote(name)}`)
      break
    case 'drop':
      await drop(name)
      break
    case 'drop-prefix': {
      const { rows } = await client.query(
        'SELECT datname FROM pg_database WHERE starts_with(datname, $1)',
        [name],
      )
      for (const row of rows) if (row.datname !== extra) await drop(row.datname)
      break
    }
    case 'rename':
      await client.query(`ALTER DATABASE ${quote(name)} RENAME TO ${quote(extra)}`)
      break
    case 'restore':
      // A template can have no connection while it is copied, and has none: nothing but this
      // script opens it.
      await drop(own)
      await client.query(`CREATE DATABASE ${quote(own)} TEMPLATE ${quote(name)}`)
      break
    default:
      console.error(`Unknown command: ${command}`)
      process.exitCode = 2
  }
} finally {
  await client.end()
}
