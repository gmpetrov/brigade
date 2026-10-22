// What the demo's server and its tests share (scripts/demo-record.mjs keys requests the same way).

// Query parameters that change with each visit (a timeline's window): left out of keys.
const VOLATILE = new Set(['from', 'to'])

/** A request's key in the fixtures: method, path under /api, and its stable query, sorted. */
export function keyOf(method: string, url: string) {
  const u = new URL(url)
  const params = [...u.searchParams].filter(([k]) => !VOLATILE.has(k)).sort()
  const search = params.length ? `?${new URLSearchParams(params)}` : ''
  return `${method} ${u.pathname.replace(/^\/api/, '')}${search}`
}

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/

/**
 * A copy of the recorded responses with every date moved by `shift` ms, so the
 * workspace looks as it did when recorded but now, and the preview's address
 * ({{origin}}) replaced by the demo's.
 */
export function reviveDates<T>(value: T, shift: number, origin: string): T {
  const go = (v: unknown): unknown => {
    if (typeof v === 'string') {
      if (ISO.test(v)) return new Date(Date.parse(v) + shift).toISOString()
      return v.includes('{{origin}}') ? v.replaceAll('{{origin}}', origin) : v
    }
    if (Array.isArray(v)) return v.map(go)
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, go(x)]))
    return v
  }
  return go(value) as T
}
