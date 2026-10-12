// Reading a pasted .env file, so pasting one fills a form with its variables.

export type EnvEntry = { name: string; value: string }

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s?(.*)$/

/**
 * The variables of a .env file, in order, a later one replacing an earlier
 * one of the same name. Comments and blank lines are left out; quoted values
 * may span lines, and double-quoted ones take \n, \t, \" and \\.
 */
export function parseDotenv(text: string): EnvEntry[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const found = new Map<string, string>()
  for (let i = 0; i < lines.length; i++) {
    const match = LINE.exec(lines[i]!)
    if (!match) continue
    const name = match[1]!
    let rest = match[2]!.trimStart()
    const quote = rest[0]
    if (quote === '"' || quote === "'" || quote === '`') {
      // Up to the closing quote, on this line or a later one.
      let body = rest.slice(1)
      let end = closing(body, quote)
      while (end < 0 && i + 1 < lines.length) {
        body += `\n${lines[++i]}`
        end = closing(body, quote)
      }
      const raw = end < 0 ? body : body.slice(0, end)
      found.set(
        name,
        quote === '"'
          ? raw.replace(/\\([nrt"\\])/g, (_, c: string) =>
              c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c,
            )
          : raw,
      )
      continue
    }
    // Unquoted: up to a comment after a space.
    const comment = rest.search(/\s#/)
    if (comment >= 0) rest = rest.slice(0, comment)
    found.set(name, rest.trim())
  }
  return [...found].map(([name, value]) => ({ name, value }))
}

/** Where a value's closing quote is, past escaped ones in a double-quoted value. */
function closing(body: string, quote: string) {
  for (let i = 0; i < body.length; i++) {
    if (quote === '"' && body[i] === '\\') i++
    else if (body[i] === quote) return i
  }
  return -1
}

/**
 * The variables pasted into a field, when the paste is a .env file rather
 * than one value: several lines, or NAME=… in a name field. In a value field,
 * one line counts only when it names that field's own variable (a value may
 * itself hold "=").
 */
export function pastedEnv(
  text: string,
  field: { value: true; name?: string } | { value: false },
): EnvEntry[] | null {
  const entries = parseDotenv(text)
  if (!entries.length) return null
  if (!field.value || text.trim().includes('\n')) return entries
  return entries.length === 1 && entries[0]!.name === field.name ? entries : null
}
