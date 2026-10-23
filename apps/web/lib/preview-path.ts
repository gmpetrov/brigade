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
