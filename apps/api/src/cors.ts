// Which pages may call the API from the browser: the dashboard's origins (WEB_URL), with its
// session cookie. The API answers with it (src/app.ts), and on Cloudflare the Worker in front
// of it answers browsers' preflights with it too (src/front.ts).
import type { MiddlewareHandler } from 'hono'
import { cors } from 'hono/cors'

export const apiCors = (origins: string[]) =>
  cors({
    origin: origins,
    credentials: true,
    // How long a browser may skip asking again before a write to the same address (Chrome
    // keeps it 2 hours at most; without it, 5 seconds): each ask is a trip to the API.
    maxAge: 7200,
  })

/** What a page can send another site without asking first (no CORS preflight). */
const FORM_LIKE = /^\s*(application\/x-www-form-urlencoded|multipart\/form-data|text\/plain)\b/i

/**
 * Cross-site request forgery: a write a browser sends with the session cookie must come from one
 * of the dashboard's origins. JSON writes already need CORS's preflight; this covers the kinds a
 * page elsewhere (even a sibling subdomain, which SameSite=Lax lets through) can send without
 * one: a form or a multipart or plain-text body. Without a cookie, it is no browser's session
 * (runners, webhooks, git): left to their own authentication.
 */
export const apiCsrf =
  (origins: string[]): MiddlewareHandler =>
  async (c, next) => {
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) &&
      c.req.header('cookie') &&
      FORM_LIKE.test(c.req.header('content-type') ?? 'text/plain') &&
      !origins.includes(c.req.header('origin') ?? '')
    )
      return c.json({ error: 'This request did not come from Brigade' }, 403)
    await next()
  }
