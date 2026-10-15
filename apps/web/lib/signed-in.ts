// Whether this browser was signed in when it last asked, kept in a cookie of the
// dashboard's own: the session cookie is the API's, out of reach here. The landing
// and sign-in pages read it in an inline script and go to /app at once, without a
// request to the API or work in the dashboard's Worker. A stale one costs a trip:
// /app gets a 401, clears it and sends the browser back to sign in.
const NAME = 'brigade_signed_in'

export function markSignedIn() {
  const secure = location.protocol === 'https:' ? '; secure' : ''
  document.cookie = `${NAME}=1; path=/; max-age=${60 * 60 * 24 * 30}; samesite=lax${secure}`
}

export function markSignedOut() {
  document.cookie = `${NAME}=; path=/; max-age=0`
}

/** Runs as the page's HTML is read, before it paints. */
export const redirectIfSignedInScript = `if(/(?:^|; )${NAME}=1/.test(document.cookie))location.replace('/app')`
