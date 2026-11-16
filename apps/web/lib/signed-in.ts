import { API_URL } from './config'
import { desktopBridge } from './desktop-bridge'

// Whether this browser was signed in when it last asked, kept in a cookie of the
// dashboard's own: the session cookie is the API's, out of reach here. The landing
// and sign-in pages read it in an inline script and go to /app at once, without a
// request to the API or work in the dashboard's Worker. A stale one costs a trip:
// /app gets a 401, clears it and sends the browser back to sign in.
const NAME = 'brigade_signed_in'
const KNOWN = 'brigade_known'

/**
 * Where to go once signed in: /app, or the page that sent the browser to sign in (?next=),
 * when it is the dashboard's own or an App's sign-in coming back to the API.
 */
export function afterSignIn() {
  const next = new URLSearchParams(location.search).get('next')
  if (!next) return '/app'
  try {
    const url = new URL(next, location.origin)
    if (
      url.origin === location.origin &&
      (url.pathname.startsWith('/app') || url.pathname.startsWith('/invite/'))
    )
      return url.href
    if (
      url.origin === new URL(API_URL).origin &&
      url.pathname.startsWith('/api/connections/oauth/')
    )
      return url.href
  } catch {}
  return '/app'
}

export function markSignedIn() {
  const secure = location.protocol === 'https:' ? '; secure' : ''
  document.cookie = `${NAME}=1; path=/; max-age=${60 * 60 * 24 * 30}; samesite=lax${secure}`
  // Kept through signing out: Brigade.app's window does not start a guest where someone was
  // signed in before (lib/guest.ts).
  document.cookie = `${KNOWN}=1; path=/; max-age=${60 * 60 * 24 * 400}; samesite=lax${secure}`
}

/** Whether someone was ever signed in in this browser (or Brigade.app's window). */
export const signedInBefore = () => new RegExp(`(?:^|; )${KNOWN}=1`).test(document.cookie)

export function markSignedOut() {
  document.cookie = `${NAME}=; path=/; max-age=0`
}

/**
 * On signing out, leave nothing of the account in this browser: drafts, recent searches and
 * other local state, and this device's push subscription, so the next person on it sees none
 * of it and gets none of the previous member's notifications. What the page keeps in memory
 * goes with it: every sign-out ends on a full page load (location, not the router).
 */
export async function clearBrowserData() {
  try {
    localStorage.clear()
    sessionStorage.clear()
  } catch {}
  try {
    const reg = await navigator.serviceWorker?.getRegistration()
    await (await reg?.pushManager.getSubscription())?.unsubscribe()
  } catch {}
  // Brigade.app's own notifications (apps/desktop/src/notifications.ts): it stops fetching the
  // previous member's, and the API forgets that device.
  try {
    await desktopBridge()?.notifications?.disable()
  } catch {}
}

/**
 * Runs as the page's HTML is read, before it paints. Not with ?next=: the page that sent the
 * browser here found no session, so the cookie is stale.
 */
export const redirectIfSignedInScript = `if(/(?:^|; )${NAME}=1/.test(document.cookie)&&!/[?&]next=/.test(location.search))location.replace('/app')`
