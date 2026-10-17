// PostgreSQL's jsonb refuses some strings JSON allows: a NUL (\u0000) and a
// lone UTF-16 surrogate. A teammate's tool output can hold either (a log file
// with NUL padding, a binary file read as text), and one refused event stops a
// thread's events from being stored at all.

/** The value with every string made storable in jsonb: NULs dropped, lone surrogates replaced (U+FFFD). */
export function storableJson<T>(value: T): T {
  return clean(value) as T
}

function clean(value: unknown): unknown {
  if (typeof value === 'string') return cleanString(value)
  if (Array.isArray(value)) return value.map(clean)
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [cleanString(key), clean(v)]))
  return value
}

function cleanString(text: string) {
  const wellFormed = text.isWellFormed() ? text : text.toWellFormed()
  return wellFormed.includes('\u0000') ? wellFormed.replaceAll('\u0000', '') : wellFormed
}
