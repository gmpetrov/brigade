// Secrets in text: the one list of what a key, a token or a password looks like, used to
// block mail that holds one (mail/text.ts) and to mask them in a thread's events before
// they are stored (hub/runner-messages.ts). A teammate's tools see secrets all the time (a
// database URL in an env file, a webhook secret an API call returns, a token in a curl
// header), and a stored event is sent whole to every browser that opens the thread.

/**
 * A kind of secret. `pattern` is global, with three groups: what is kept before the secret,
 * the secret, and what is kept after it (each may be empty). `hint` is a substring every
 * match holds, looked for first: most strings hold none, and are left at that.
 */
type SecretPattern = {
  kind: string | ((secret: string) => string)
  hint: string | string[]
  pattern: RegExp
  /** Masked only when this holds: what a placeholder or a fixture looks like is left. Mail ignores it. */
  real?: (secret: string) => boolean
  /** Only blocks mail; never masked in events (too loose there). */
  mailOnly?: boolean
}

/** Words placeholders and fixtures are made of: a real key's random characters seldom spell them. */
const DUMMY = /fake|dummy|example|sample|placeholder|test|xxxx|your|redacted|changeme/i

/** A key's fixed start (sk_live_, sk-ant-api03-, github_pat_), which says nothing of the key. */
const KEY_PREFIX = /^(?:[a-z]+\d*[_.-])+/

/** How many of lower-case letters, upper-case letters and digits the text holds. */
function classes(text: string) {
  return (/[a-z]/.test(text) ? 1 : 0) + (/[A-Z]/.test(text) ? 1 : 0) + (/\d/.test(text) ? 1 : 0)
}

/** Random-looking: no placeholder word, and at least `min` kinds of characters. */
const random =
  (min: number) =>
  (secret: string): boolean =>
    !DUMMY.test(secret) && classes(secret) >= min

/** The same, of a key after its fixed start: sk_test_ is a Stripe key, not a fixture. */
const randomKey = (min: number) => (secret: string) => random(min)(secret.replace(KEY_PREFIX, ''))

/** A value written in place of a secret: a variable, a template, stars. */
const TEMPLATE = /^(?:\$|<|\{|%\(|\*+$|\[redacted)/

/** The base64 characters a PEM block's body holds, with its line breaks (real or escaped in JSON). */
const PEM_BODY = String.raw`(?:[A-Za-z0-9+/=]|\s|\\[nr])*`

export const SECRET_PATTERNS: SecretPattern[] = [
  {
    // The password only: the user and the host say which database it was.
    kind: (secret) => (secret.startsWith('npg_') ? 'a Neon password' : 'a database password'),
    hint: '://',
    pattern:
      /\b((?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^:/?#@\s"'`]+:)([^@/?#\s"'`]+)(@)/gi,
    real: (secret) => !TEMPLATE.test(secret) && !DUMMY.test(secret),
  },
  {
    kind: 'a Neon password',
    hint: 'npg_',
    pattern: /()\b(npg_[A-Za-z0-9]{10,})()/g,
    real: randomKey(2),
  },
  {
    kind: 'a Stripe secret key',
    hint: ['_live_', '_test_'],
    pattern: /()\b((?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,})()/g,
    real: randomKey(2),
  },
  {
    kind: 'a webhook signing secret',
    hint: 'whsec_',
    pattern: /()\b(whsec_[A-Za-z0-9+/=]{10,})()/g,
    real: randomKey(2),
  },
  {
    kind: 'a Resend API key',
    hint: 're_',
    pattern: /()\b(re_[A-Za-z0-9]{8,}_[A-Za-z0-9]{8,})()/g,
    // Snake-case names (re_render_component) hold one kind of letter only.
    real: randomKey(2),
  },
  {
    kind: 'a GitHub token',
    hint: ['gh', 'github_pat_'],
    pattern: /()\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,})()/g,
    real: randomKey(2),
  },
  {
    kind: 'an AWS access key',
    hint: ['AKIA', 'ASIA'],
    pattern: /()\b((?:AKIA|ASIA)[0-9A-Z]{16})()\b/g,
    real: random(1),
  },
  {
    kind: 'a Slack token',
    hint: 'xox',
    pattern: /()\b(xox[abposr]-[A-Za-z0-9-]{10,})()/g,
    real: randomKey(2),
  },
  {
    kind: 'a Google API key',
    hint: 'AIza',
    pattern: /()\b(AIza[0-9A-Za-z_-]{35})()\b/g,
    real: randomKey(2),
  },
  {
    kind: 'a Google access token',
    hint: 'ya29.',
    pattern: /()\b(ya29\.[\w-]{20,})()/g,
    real: randomKey(2),
  },
  {
    kind: 'a database API key',
    hint: ['napi_', 'sbp_'],
    pattern: /()\b((?:napi|sbp)_[A-Za-z0-9]{20,})()/g,
    real: randomKey(2),
  },
  {
    // Anthropic's before OpenAI's, which would read it as its own.
    kind: 'an Anthropic API key',
    hint: 'sk-ant-',
    pattern: /()\b(sk-ant-[A-Za-z0-9_-]{20,})()/g,
    real: randomKey(3),
  },
  {
    kind: 'an OpenAI API key',
    hint: 'sk-',
    pattern: /()\b(sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,})()/g,
    real: randomKey(3),
  },
  {
    // With a body only: a header alone (a fixture, a docs line) holds no key.
    kind: 'a private key',
    hint: 'PRIVATE KEY-----',
    pattern: new RegExp(
      String.raw`(-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)(${PEM_BODY})(-----END [A-Z0-9 ]*PRIVATE KEY-----|)`,
      'g',
    ),
    real: (body) => body.replace(/\\[nr]|[^A-Za-z0-9+/=]/g, '').length >= 64,
  },
  {
    // The token only: "Bearer" says what it was. A variable ($TOKEN) is left.
    kind: 'a token',
    hint: ['earer', 'asic', 'EARER', 'ASIC'],
    pattern:
      /(\bAuthorization["']?\s*[:=]\s*["']?\s*(?:Bearer|Basic)\s+)([A-Za-z0-9._~+/-]{16,}=*)()/gi,
    real: random(2),
  },
  {
    // Environment variables and flags named for a secret, as a process listing or an env file shows them.
    kind: 'a secret',
    hint: ['KEY', 'SECRET', 'TOKEN', 'PASSW', '--'],
    pattern:
      /((?:\b(?:[A-Z0-9]+_)*(?:API_?KEY|ACCESS_KEY|PRIVATE_KEY|SECRET(?:_KEY)?|TOKEN|PASSWORD|PASSWD)\s*=\s*|--(?:api-key|token|secret|password)[= ])["']?)([^\s"'`]{12,})()/g,
    real: (secret) => !TEMPLATE.test(secret) && random(2)(secret),
  },
  {
    kind: 'a private key',
    hint: 'PRIVATE KEY-----',
    pattern: /()(-----BEGIN [A-Z ]*PRIVATE KEY-----)()/g,
    mailOnly: true,
  },
  {
    kind: 'a password',
    hint: ['ass', 'ASS', 'mot de passe'],
    pattern: /()\b((?:password|passwd|mot de passe)\s*[:=]\s*\S{6,})()/gi,
    mailOnly: true,
  },
]

const holdsHint = (text: string, hint: string | string[]) =>
  typeof hint === 'string' ? text.includes(hint) : hint.some((h) => text.includes(h))

const kindOf = (p: SecretPattern, secret: string) =>
  typeof p.kind === 'string' ? p.kind : p.kind(secret)

/** What secret the text holds, if any (its kind, never the secret). Strict: a placeholder counts. */
export function secretIn(text: string) {
  for (const p of SECRET_PATTERNS) {
    if (!holdsHint(text, p.hint)) continue
    p.pattern.lastIndex = 0
    const match = p.pattern.exec(text)
    p.pattern.lastIndex = 0
    if (match) return kindOf(p, match[2]!)
  }
  return null
}

const MASKED = SECRET_PATTERNS.filter((p) => !p.mailOnly)

/** What stands in a secret's place. */
export const redacted = (kind: string) => `[redacted: ${kind}]`

/** The text with each secret in it replaced by what kind it was; the same string when it holds none. */
export function maskSecrets(text: string): string {
  let out = text
  for (const p of MASKED) {
    if (!holdsHint(out, p.hint)) continue
    out = out.replace(p.pattern, (whole, before: string, secret: string, after: string) =>
      p.real && !p.real(secret) ? whole : `${before}${redacted(kindOf(p, secret))}${after}`,
    )
  }
  return out
}

/**
 * The value with every string in it masked (maskSecrets), at any depth; object keys are
 * left. The same value, not a copy, when it holds no secret: events are stored by the
 * hundred thousand, and most hold none.
 */
export function maskSecretsIn<T>(value: T): T {
  return mask(value) as T
}

function mask(value: unknown): unknown {
  if (typeof value === 'string') return maskSecrets(value)
  if (Array.isArray(value)) {
    let copy: unknown[] | undefined
    value.forEach((v, i) => {
      const masked = mask(v)
      if (masked !== v) (copy ??= [...value])[i] = masked
    })
    return copy ?? value
  }
  if (isPlain(value)) {
    let copy: Record<string, unknown> | undefined
    for (const [key, v] of Object.entries(value)) {
      const masked = mask(v)
      if (masked !== v) (copy ??= { ...value })[key] = masked
    }
    return copy ?? value
  }
  return value
}

const isPlain = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
