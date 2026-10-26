// The path a person types in the preview panel's bar, and the address it opens.

/**
 * The preview's address with another path: what a person typed, keeping the
 * address's own query (its token) unless the path sets the same one.
 */
export function withPath(url: string, path: string) {
  const base = new URL(url)
  const target = new URL(typedPath(path), base.origin)
  // Never the token on another address.
  if (target.origin !== base.origin) return base.href
  for (const [name, value] of base.searchParams)
    if (!target.searchParams.has(name)) target.searchParams.append(name, value)
  return target.href
}

/**
 * What a person types in the bar, as a path on the preview's address: `app` is `/app`.
 * A browser reads `\` as `/`, so `//host` and `/\host` are paths too, never another host.
 */
export function typedPath(text: string) {
  const path = text
    // As a browser does, before reading where it goes.
    .replace(/[\t\n\r]/g, '')
    .trim()
    .replace(/^https?:[\\/]{2}[^/\\]*/i, '')
    .replace(/^[\\/]*/, '/')
  const { pathname, search, hash } = new URL(path, 'http://preview.invalid')
  // A path that resolves to `//host` (`/a/..//host`) stays one.
  return pathname.replace(/^\/+/, '/') + search + hash
}

/**
 * Whether a page's origin is the preview's at `origin`: the same, or a grant of it, where the
 * preview gateway sends a browser that drops its cookie in the dashboard's frame (Safari):
 * https://<id>-<grant>.brigade.surf for https://<id>.brigade.surf.
 */
export function previewOrigin(candidate: string, origin: string) {
  if (candidate === origin) return true
  if (!URL.canParse(candidate) || !URL.canParse(origin)) return false
  const page = new URL(candidate)
  const preview = new URL(origin)
  if (page.protocol !== 'https:' || preview.protocol !== 'https:' || page.port !== preview.port)
    return false
  const [id, ...domain] = preview.hostname.split('.')
  const [label, ...rest] = page.hostname.split('.')
  return (
    !!domain.length &&
    rest.join('.') === domain.join('.') &&
    new RegExp(`^${id}-[a-z2-7]{36}$`).test(label!)
  )
}
