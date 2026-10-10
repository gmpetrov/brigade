import { serve } from '@hono/node-server'
import { WebSocketServer } from 'ws'
import { app } from './app.js'
import { sweepUploads } from './attachments.js'
import { env } from './config.js'
import { watchSubscriptions } from './subscriptions/index.js'

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

watchSubscriptions()

// Uploads abandoned mid-way or never sent with a message.
const sweep = () =>
  void sweepUploads().catch((error) => console.warn(`upload sweep failed: ${String(error)}`))
setTimeout(sweep, 60_000).unref()
setInterval(sweep, 60 * 60_000).unref()
