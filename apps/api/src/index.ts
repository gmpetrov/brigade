// The API on Node.js: one process (a VPS, or development). src/worker.ts is the
// same API on Cloudflare Workers.
import { serve } from '@hono/node-server'
import { WebSocketServer } from 'ws'
import { app } from './app.js'
import { env } from './config.js'
import { startJobs } from './jobs.js'

serve(
  {
    fetch: app.fetch,
    port: env.PORT,
    websocket: { server: new WebSocketServer({ noServer: true }) },
  },
  (info) => {
    console.log(`api listening on http://localhost:${info.port}`)
  },
)

startJobs()
