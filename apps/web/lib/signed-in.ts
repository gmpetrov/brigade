import { API_URL } from './config'

// Whether this browser was signed in when it last asked, kept in a cookie of the
// dashboard's own: the session cookie is the API's, out of reach here. The landing
// and sign-in pages read it in an inline script and go to /app at once, without a
// request to the API or work in the dashboard's Worker. A stale one costs a trip:
// /app gets a 401, clears it and sends the browser back to sign in.
const NAME = 'brigade_signed_in'

/**
 * Where to go once signed in: /app, or the page that sent the browser to sign in (?next=),
 * when it is the dashboard's own or an App's sign-in coming back to the API.
 */
export function afterSignIn() {
  const next = new URLSearchParams(location.search).get('next')
  if (!next) return '/app'
  try {
    const url = new URL(next, location.origin)
    if (url.origin === location.origin && url.pathname.startsWith('/app')) return url.href
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
}

export function markSignedOut() {
  document.cookie = `${NAME}=; path=/; max-age=0`
}

/**
 * Runs as the page's HTML is read, before it paints. Not with ?next=: the page that sent the
 * browser here found no session, so the cookie is stale.
 */
export const redirectIfSignedInScript = `if(/(?:^|; )${NAME}=1/.test(document.cookie)&&!/[?&]next=/.test(location.search))location.replace('/app')`
