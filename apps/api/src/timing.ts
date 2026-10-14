// Server-Timing on each API response: how long its database queries took and how many it
// ran, next to the whole request's time. Shown in the browser's Network tab, to compare
// where the API runs (Node on a server, or a Durable Object on Cloudflare).
import { AsyncLocalStorage } from 'node:async_hooks'
import type { MiddlewareHandler } from 'hono'
import { env } from './config.js'

type Tally = { queries: number; ms: number }

const current = new AsyncLocalStorage<Tally>()

/** Count a query the database client ran, toward the request it ran for. */
export function countQuery(ms: number) {
  const tally = current.getStore()
  if (!tally) return
  tally.queries++
  tally.ms += ms
}

export const serverTiming: MiddlewareHandler = async (c, next) => {
  const tally: Tally = { queries: 0, ms: 0 }
  const start = performance.now()
  await current.run(tally, next)
  // A WebSocket's 101 answer cannot take headers.
  if (c.res.status === 101) return
  const timing = `db;dur=${Math.round(tally.ms)};desc="${tally.queries} queries", total;dur=${Math.round(performance.now() - start)}`
  try {
    c.header('Server-Timing', timing)
  } catch {
    // A response passed on from fetch() has read-only headers: answer with a copy.
    c.res = new Response(c.res.body, c.res)
    c.header('Server-Timing', timing)
  }
  c.header('Timing-Allow-Origin', env.WEB_URL.join(', '))
}
