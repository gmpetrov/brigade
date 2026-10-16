/**
 * A provider's sign-in in a window of its own. Providers refuse to load in a
 * frame (Cloudflare, Google), so the page that asked stays where it is and the
 * sign-in comes back to /app/connections?popup=1, which closes itself.
 */
export const SIGN_IN_RETURN = '/app/connections?popup=1'

/**
 * Open the window on the click, so it is not blocked, then send it to the
 * provider once the API has made the address. Returns false when the browser
 * blocked it; the caller then signs in on this page instead.
 */
export async function openSignIn(address: (returnTo?: string) => Promise<string>) {
  const popup = window.open('', 'brigade-sign-in', 'popup,width=520,height=720')
  if (!popup) {
    window.location.href = await address()
    return false
  }
  try {
    popup.location.href = await address(SIGN_IN_RETURN)
    return true
  } catch (error) {
    popup.close()
    throw error
  }
}
