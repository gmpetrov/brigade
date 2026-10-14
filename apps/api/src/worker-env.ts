// Runs before any other module of the Worker (src/worker.ts imports it first):
// config.ts reads process.env as it loads, and Workers put only text bindings there.
import { env } from 'cloudflare:workers'

const bindings = env as unknown as { HYPERDRIVE?: { connectionString: string } }
if (bindings.HYPERDRIVE) process.env.DATABASE_URL = bindings.HYPERDRIVE.connectionString
