// Which pages may call the API from the browser: the dashboard's origins (WEB_URL), with its
// session cookie. The API answers with it (src/app.ts), and on Cloudflare the Worker in front
// of it answers browsers' preflights with it too (src/front.ts).
import { cors } from 'hono/cors'

export const apiCors = (origins: string[]) =>
  cors({
    origin: origins,
    credentials: true,
    // How long a browser may skip asking again before a write to the same address (Chrome
    // keeps it 2 hours at most; without it, 5 seconds): each ask is a trip to the API.
    maxAge: 7200,
  })
