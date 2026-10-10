import { serve } from '@hono/node-server'
import { WebSocketServer } from 'ws'
import { app } from './app.js'
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
