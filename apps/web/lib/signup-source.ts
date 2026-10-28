// Where a visitor came from, carried to sign-up in the address alone (docs/analytics.md,
// "Attribution"): no cookie, nothing stored. The site's first page reads its utm_* parameters,
// the referrer's host (another site's) and its own path; the site's links to /sign-up and
// /sign-in carry them; the sign-up and sign-in pages send them to the API with the code or
// through Google's round trip, which keeps them once on the new account
// (apps/api/src/signup-source.ts). Imports nothing: the sign-in pages use it too.

/** The parameters carried, and the only ones the API reads. */
export const SOURCE_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'ref',
  'lp',
  'paid',
] as const
export type SignupSource = Partial<Record<(typeof SOURCE_KEYS)[number], string>>

/** Ad click ids: the visit was paid for (a Google ad is not organic search). */
const CLICK_IDS = ['gclid', 'gbraid', 'wbraid', 'msclkid', 'fbclid', 'twclid', 'li_fat_id']

/** The referrer's host, when it is another site's (not Brigade's own pages). */
export function externalReferrer(referrer: string, here: string) {
  try {
    const host = new URL(referrer).hostname.toLowerCase()
    if (!host || host === here || host === 'brigade.lol' || host.endsWith('.brigade.lol'))
      return undefined
    return host
  } catch {
    return undefined
  }
}

/** What an address already carries: the first page's, passed on by its links. */
export function carried(search: string): SignupSource {
  const query = new URLSearchParams(search)
  const out: SignupSource = {}
  for (const key of SOURCE_KEYS) {
    const value = query.get(key)?.slice(0, 200)
    if (value) out[key] = value
  }
  return out
}

/**
 * Where this visit came from, as its address and referrer say: what the address carries
 * already when a link of the site brought it, else read from them now.
 */
export function sourceOf(
  location: { search: string; pathname: string; hostname: string },
  referrer: string,
) {
  // Brought by a link of the site, which always passes on the first page (lp).
  const known = carried(location.search)
  if (known.lp) return known
  const query = new URLSearchParams(location.search)
  const ref = externalReferrer(referrer, location.hostname)
  return {
    ...carried(`?${new URLSearchParams([...query].filter(([k]) => k.startsWith('utm_')))}`),
    ...(ref && { ref }),
    lp: location.pathname,
    ...(CLICK_IDS.some((id) => query.has(id)) && { paid: '1' }),
  } satisfies SignupSource
}

let first: SignupSource | undefined

/**
 * This visit's source, read on the first page and kept for the pages after it (the site's
 * pages change without loading again). In memory only.
 */
export function visitSource() {
  if (typeof window === 'undefined') return {}
  first ??= sourceOf(window.location, document.referrer)
  return first
}

/** A path with the visit's source in its query. */
export function withSource(path: string, source: SignupSource) {
  const entries = Object.entries(source).filter(([, v]) => v) as [string, string][]
  if (entries.length === 0) return path
  const [base, query = ''] = path.split('?')
  const params = new URLSearchParams(query)
  for (const [key, value] of entries) params.set(key, value)
  return `${base}?${params}`
}

/**
 * What the sign-up and sign-in pages send to the API: what their address carries, else the
 * referrer when someone came to them straight from another site. Undefined when nothing.
 */
export function signupSourceHere(): SignupSource | undefined {
  if (typeof window === 'undefined') return undefined
  const known = carried(location.search)
  if (Object.keys(known).length) return known
  const ref = externalReferrer(document.referrer, location.hostname)
  return ref ? { ref, lp: location.pathname } : undefined
}
