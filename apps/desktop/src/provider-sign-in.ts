// A provider's sign-in (an App account: Google, an MCP server…) started in one of the app's
// windows goes to the browser, where it works and the person's passwords are. Its return page
// sends the result back as brigade://signed-in with a one-time value the app gave the page that
// started it: only a sign-in this app started gets through, once, within half an hour.
import { randomBytes } from 'node:crypto'

const LIFETIME_MS = 30 * 60_000

const pending = new Map<string, number>()

export function startProviderSignIn(now = Date.now()) {
  for (const [nonce, until] of pending) if (until <= now) pending.delete(nonce)
  const nonce = randomBytes(24).toString('base64url')
  pending.set(nonce, now + LIFETIME_MS)
  return nonce
}

/** Whether `nonce` is one this app gave and has not taken yet; taken now. */
export function takeProviderSignIn(nonce: string, now = Date.now()) {
  const until = pending.get(nonce)
  pending.delete(nonce)
  return until !== undefined && until > now
}
