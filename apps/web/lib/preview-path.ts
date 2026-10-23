// The path a person types in the preview panel's bar, and the address it opens.

/**
 * The preview's address with another path: what a person typed, keeping the
 * address's own query (its token) unless the path sets the same one.
 */
export function withPath(url: string, path: string) {
  const base = new URL(url)
  const target = new URL(path, base.origin)
  for (const [name, value] of base.searchParams)
    if (!target.searchParams.has(name)) target.searchParams.append(name, value)
  return target.href
}

/** What a person types in the bar, as a path on the preview's address: `app` is `/app`. */
export function typedPath(text: string) {
  const path = text.trim().replace(/^https?:\/\/[^/]+/i, '')
  return path.startsWith('/') && !path.startsWith('//') ? path : `/${path.replace(/^\/+/, '')}`
}
