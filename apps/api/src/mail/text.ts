// An email's words as a teammate reads them: plain text from HTML (links kept, since a sign-up's
// link is the point), the few headers that say what kind of mail it is, and the checks run on
// what a teammate sends.

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  eacute: 'é',
  egrave: 'è',
  agrave: 'à',
  ccedil: 'ç',
}

export function decodeEntities(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n =
        code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1))
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole
    }
    return ENTITIES[code.toLowerCase()] ?? whole
  })
}

/** HTML as plain text: blocks on their own lines, each link as "text (url)", no styles or scripts. */
export function htmlToText(html: string | null | undefined) {
  if (!html) return ''
  const text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(style|script|head|title)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(
      /<a\b[^>]*?href\s*=\s*("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi,
      (_, __, dq, sq, inner) => {
        const href = decodeEntities(String(dq ?? sq ?? '')).trim()
        const label = String(inner)
          .replace(/<[^>]+>/g, '')
          .replace(/\s+/g, ' ')
          .trim()
        if (!href || /^(mailto:|#)/i.test(href)) return label
        // In parentheses: angle brackets would read as a tag below.
        return label && decodeEntities(label) !== href ? `${label} (${href})` : href
      },
    )
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|section|table)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
  return decodeEntities(text)
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** The Message-IDs in an In-Reply-To or References header, in order. */
export function messageIds(value: string | string[] | undefined | null) {
  const text = Array.isArray(value) ? value.join(' ') : (value ?? '')
  return text.match(/<[^<>\s]+>/g) ?? []
}

/** A header's value from Resend's headers object, whatever its case; several values joined. */
export function headerOf(
  headers: Record<string, string | string[]> | null | undefined,
  name: string,
) {
  if (!headers) return undefined
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name)
  if (!key) return undefined
  const value = headers[key]
  return Array.isArray(value) ? value.join(' ') : value
}

/** The headers Brigade keeps with an email, lower-cased and short. */
export const KEPT_HEADERS = [
  'auto-submitted',
  'precedence',
  'x-autoreply',
  'x-autorespond',
  'list-id',
  'list-unsubscribe',
  'content-type',
  'from',
  'reply-to',
  'date',
  'return-path',
  'x-brigade-test',
]

/** Sent by a machine (an out-of-office, a notification), by its headers, as Gmail's trigger tells. */
export function automaticHeaders(headers: Record<string, string>) {
  const submitted = headers['auto-submitted']?.trim().toLowerCase()
  const precedence = headers.precedence?.trim().toLowerCase()
  return (
    (!!submitted && submitted !== 'no') ||
    headers['x-autoreply'] !== undefined ||
    headers['x-autorespond'] !== undefined ||
    precedence === 'auto_reply' ||
    precedence === 'bulk' ||
    precedence === 'list' ||
    headers['list-id'] !== undefined
  )
}

/** A delivery status notification: a mail server saying an email could not be delivered. */
export function bounceOf(from: string, headers: Record<string, string>) {
  const type = headers['content-type']?.toLowerCase() ?? ''
  return (
    /report-type\s*=\s*"?delivery-status/.test(type) ||
    /^(mailer-daemon|postmaster)@/i.test(from.trim())
  )
}

/** Patterns of secrets nobody should mail: keys, tokens, private keys, passwords in clear. */
const SECRETS: [RegExp, string][] = [
  [/\b(sk|rk)_(live|test)_[A-Za-z0-9]{10,}/, 'a Stripe secret key'],
  [/\bwhsec_[A-Za-z0-9+/=]{10,}/, 'a webhook signing secret'],
  [/\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{8,}/, 'a Resend API key'],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,})/, 'a GitHub token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'a Google API key'],
  [/\bya29\.[\w-]{20,}/, 'a Google access token'],
  [/\b(napi|sbp)_[A-Za-z0-9]{20,}/, 'a database API key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\bsk-(ant-|proj-)?[A-Za-z0-9_-]{20,}/, 'an AI provider key'],
  [/\b(password|passwd|mot de passe)\s*[:=]\s*\S{6,}/i, 'a password'],
]

/** What secret the text holds, if any (its kind, never the secret). */
export function secretIn(text: string) {
  for (const [pattern, kind] of SECRETS) if (pattern.test(text)) return kind
  return null
}
