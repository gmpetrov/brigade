/**
 * A provider's sign-in in a tab of its own. Providers refuse to load in a
 * frame (Cloudflare, Google), so the page that asked stays where it is and the
 * sign-in comes back to /app/connections?popup=1, which closes the tab.
 */
export const SIGN_IN_RETURN = '/app/connections?popup=1'

/**
 * Open the tab on the click, so it is not blocked, then send it to the
 * provider once the API has made the address. A tab rather than a popup window:
 * full size, and it cannot get lost behind the browser. Named, so a second
 * click reuses it. Returns false when the browser blocked it; the caller then
 * signs in on this page instead.
 */
export async function openSignIn(address: (returnTo?: string) => Promise<string>) {
  const tab = window.open('', 'brigade-sign-in')
  if (!tab) {
    window.location.href = await address()
    return false
  }
  try {
    tab.location.href = await address(SIGN_IN_RETURN)
    return true
  } catch (error) {
    tab.close()
    throw error
  }
}

/** What the sign-in tab came back with: the account signed in to, or why it was not. */
export type SignInResult = { connected?: string; error?: string }

const CHANNEL = 'brigade-sign-in'

/**
 * The sign-in tab tells the pages that wait for it. Only a sign-in that went through names an
 * account: a change to the account's settings meanwhile says nothing.
 */
export function tellSignIn(result: SignInResult) {
  if (typeof BroadcastChannel === 'undefined') return
  const channel = new BroadcastChannel(CHANNEL)
  channel.postMessage(result)
  channel.close()
}

/** Listen for the sign-in tab's result; returns the cleanup. */
export function onSignIn(listener: (result: SignInResult) => void) {
  if (typeof BroadcastChannel === 'undefined') return () => {}
  const channel = new BroadcastChannel(CHANNEL)
  channel.onmessage = (event: MessageEvent<SignInResult>) => listener(event.data)
  return () => channel.close()
}
