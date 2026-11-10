// TEMPORARY, for Google's CASA assessment only: remove once the lab's letter of validation is in.
//
// The lab's scanner signs in to the test account before its authenticated scan, but only tries
// a fixed list of login URLs (/api/auth/login, /api/v1/auth/login, ...) and never Brigade's own
// /api/auth/sign-in/email. These aliases take its form or JSON body and hand it, as JSON, to
// that same better-auth endpoint: same password check, rate limits and session cookie. Only
// accounts with a password can sign in this way, and nobody can make one in production
// (password-sign-in.ts).
import type { Context } from 'hono'
import { env } from './config.js'

type Auth = { handler: (request: Request) => Promise<Response> }

async function fields(request: Request): Promise<Record<string, unknown>> {
  const type = request.headers.get('content-type') ?? ''
  try {
    if (type.includes('application/json')) return ((await request.json()) ?? {}) as never
    if (type.includes('form')) return Object.fromEntries(await request.formData())
  } catch {}
  return {}
}

const text = (value: unknown) => (typeof value === 'string' ? value : '')

export const scannerLogin = (auth: Auth) => async (c: Context) => {
  const body = await fields(c.req.raw)
  const email = text(body.email) || text(body.username) || text(body.login)
  const password = text(body.password)
  if (!email || !password) return c.json({ error: 'Email and password are needed' }, 400)
  const headers = new Headers(c.req.raw.headers)
  headers.set('content-type', 'application/json')
  headers.delete('content-length')
  return auth.handler(
    new Request(`${env.API_URL}/api/auth/sign-in/email`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email, password }),
    }),
  )
}
