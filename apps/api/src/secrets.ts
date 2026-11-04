// Secrets in text: the one list of what a key, a token or a password looks like, used to
// block mail that holds one (mail/text.ts) and to mask them in a thread's events before
// they are stored (hub/runner-messages.ts). A teammate's tools see secrets all the time (a
// database URL in an env file, a webhook secret an API call returns, a token in a curl
// header), and a stored event is sent whole to every browser that opens the thread.

/**
 * A kind of secret. `pattern` is global, with three groups: what is kept before the secret,
 * the secret, and what is kept after it (each may be empty). `hint` is a substring every
 * match holds, looked for first: most strings hold none, and are left at that. A pattern that
 * ignores case has a hint that does too (a RegExp with the i flag).
 */
type SecretPattern = {
  kind: string | ((secret: string) => string)
  hint: string | string[] | RegExp
  pattern: RegExp
  /** Masked only when this holds: what a placeholder or a fixture looks like is left. Mail ignores it. */
  real?: (secret: string) => boolean
  /** Only blocks mail; never masked in events (too loose there). */
  mailOnly?: boolean
}

/**
 * What a placeholder or a fixture is written as: a word such as "fake" or "test" on its own,
 * between separators (sk-ant-fake-key, my_test_password), a run of x, or one character over and
 * over; AWS's documented EXAMPLE keys. A word inside random characters (Latest, 7testH9) is not
 * one: a real secret can hold any letters.
 */
const DUMMY =
  /(?:^|[-_.:/ ])(?:fake|dummy|example|sample|placeholder|test|tests|your|redacted|changeme|xx+)(?=$|[-_.:/ ])|x{4,}|(.)\1{7,}|EXAMPLE$/i

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

/**
 * The same, of a key: its kinds of characters counted after its fixed start, which says nothing
 * of the key; a Stripe key's _test_ is its mode, not a fixture.
 */
const randomKey = (min: number) => (secret: string) => {
  const body = secret.replace(KEY_PREFIX, '')
  return !DUMMY.test(secret.replace(/^(?:sk|rk)_test_/, '')) && classes(body) >= min
}

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
    // The token only: the header and its scheme say what it was. A variable ($TOKEN) is left.
    kind: 'a token',
    hint: /authoriz|api[-_]?key|auth-token/i,
    pattern:
      /(\b(?:(?:Proxy-)?Authorization["']?\s*[:=]\s*["']?\s*(?:Bearer|Basic|Token)\s+|(?:X-)?Api[-_]?Key["']?\s*[:=]\s*["']?\s*|X-Auth-Token["']?\s*[:=]\s*["']?\s*))([A-Za-z0-9._~+/-]{16,}=*)()/gi,
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
    hint: /passw|mot de passe/i,
    pattern: /()\b((?:password|passwd|mot de passe)\s*[:=]\s*\S{6,})()/gi,
    mailOnly: true,
  },
]

const holdsHint = (text: string, hint: SecretPattern['hint']) =>
  typeof hint === 'string'
    ? text.includes(hint)
    : Array.isArray(hint)
      ? hint.some((h) => text.includes(h))
      : hint.test(text)

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

/** Keys whose value is a credential as a whole: a request's headers, as a tool's input holds them. */
const CREDENTIAL_KEY = /^(?:(?:proxy-)?authorization|(?:x-)?api[-_]?key|x-auth-token)$/i

/** A header's value, masked as the header written out would be. */
function maskHeader(key: string, value: string) {
  const line = `${key}: ${value}`
  const masked = maskSecrets(line)
  return masked === line ? value : masked.slice(key.length + 2)
}

/**
 * The value with every string in it masked (maskSecrets), at any depth; object keys are
 * left. The same value, not a copy, when it holds no secret: events are stored by the
 * hundred thousand, and most hold none.
 */
export function maskSecretsIn<T>(value: T): T {
  return mask(value) as T
}

function mask(value: unknown, key?: string): unknown {
  if (typeof value === 'string')
    return key && CREDENTIAL_KEY.test(key) ? maskHeader(key, value) : maskSecrets(value)
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
      const masked = mask(v, key)
      if (masked !== v) (copy ??= { ...value })[key] = masked
    }
    return copy ?? value
  }
  return value
}

const isPlain = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype

/**
 * A reply as it streams in (message.delta), each delta masked with the text before it: a
 * secret the harness sends over several deltas ("ghp_", then the rest) is masked whole. What
 * a delta ends with is held until a space or a line break says it is a whole word, and a
 * private key's block from its BEGIN line until its END line, so no stored delta holds the
 * start of a secret whose end has not come yet; the message.done that follows holds the whole
 * reply, masked. A reply cut short loses what was held from its deltas. Its state is kept with
 * the hub (DeltaStreams), so that a hub that sleeps between two deltas goes on where it was.
 */
export class MaskedStream {
  constructor(
    /** The end of the reply's text so far: CONTEXT before what is held, and what is held. */
    private raw = '',
    /** Where in raw what is held starts. */
    private held = 0,
    private lastSeq = 0,
  ) {}

  static from(state: StreamState) {
    return new MaskedStream(state.raw, state.held, state.lastSeq)
  }

  get state(): StreamState {
    return { raw: this.raw, held: this.held, lastSeq: this.lastSeq }
  }

  /** The text to store for this delta: '' while it is held, or sent already (a delta sent again). */
  next(seq: number, text: string): string {
    if (seq <= this.lastSeq) return ''
    this.lastSeq = seq
    this.raw += text
    const space = Math.max(
      this.raw.lastIndexOf(' '),
      this.raw.lastIndexOf('\n'),
      this.raw.lastIndexOf('\t'),
    )
    let cut = this.raw.length - this.held > HOLD_MAX ? this.raw.length : space + 1
    // A private key's block open: held whole from its BEGIN line, its body masked once its END
    // line comes (or it grows past any key's size).
    const begin = this.openKey()
    if (begin >= 0 && this.raw.length - begin <= PEM_MAX) cut = Math.min(cut, begin)
    if (cut <= this.held) return ''
    // Masked with the text before it: a secret that started there (a header, a URL's scheme)
    // is masked over what goes out now as well. Where the two part, what follows goes out masked
    // from there: text that went out stays out, but it was masked as well.
    const before = maskSecrets(this.raw.slice(0, this.held))
    const masked = maskSecrets(this.raw.slice(0, cut))
    let same = 0
    while (same < before.length && before[same] === masked[same]) same++
    const out = masked.slice(same)
    const from = Math.max(0, cut - CONTEXT)
    this.raw = this.raw.slice(from)
    this.held = cut - from
    return out
  }

  /** Where the private key block still open in raw starts (its BEGIN line, or what may be one); -1 when none. */
  private openKey() {
    const begin = this.raw.lastIndexOf('-----BEGIN')
    if (begin < 0 || this.raw.indexOf('-----END', begin) >= 0) {
      // Its first dashes, still coming.
      const tail = this.raw.slice(-10)
      const dashes = tail.indexOf('-')
      return dashes >= 0 && '-----BEGIN'.startsWith(tail.slice(dashes))
        ? this.raw.length - tail.length + dashes
        : -1
    }
    const line = /^-----BEGIN(?: ([A-Z0-9 ]*)(-----)?)?/.exec(this.raw.slice(begin, begin + 80))!
    // Its header whole: held only for a private key (a certificate holds no secret).
    if (line[2]) return line[1]!.endsWith('PRIVATE KEY') ? begin : -1
    // Still coming, or followed by what no header holds.
    return begin + line[0].length === this.raw.length ? begin : -1
  }
}

type StreamState = { raw: string; held: number; lastSeq: number }

/** How much text before a delta it is masked with: a URL, a header and its token. */
const CONTEXT = 512

/** The longest private key block held across deltas: more than a 4096-bit RSA key's. */
const PEM_MAX = 8192

/** The longest text held back: a "word" longer than this goes out masked as it is. */
const HOLD_MAX = 8192

/** Most replies under way at once in a workspace: past this many, the oldest is given up. */
const STREAMS_MAX = 200

/** A reply that streamed for this long is given up: its turn ended without its message.done. */
const STREAM_MAX_MS = 60 * 60_000

/** How long a reply given up is remembered: its later deltas, if any, are not stored. */
const GIVEN_UP_MS = 24 * 60 * 60_000

/** Where the hub keeps small state that outlives its memory (HubHost.load and save). */
export type StreamStore = {
  load<T>(key: string): T | undefined
  save(key: string, value: unknown): void
}

/** State kept in memory only: a test's, or a hub's that keeps none. */
export const memoryStore = (): StreamStore => {
  const kept = new Map<string, unknown>()
  return {
    load: <T>(key: string) => structuredClone(kept.get(key)) as T | undefined,
    save: (key, value) =>
      value === undefined ? kept.delete(key) : kept.set(key, structuredClone(value)),
  }
}

/**
 * The replies under way of a hub, each one's state saved as it changes: a hub that sleeps (a
 * Durable Object's memory goes, its storage stays) goes on with them where it was. Replies under
 * way, and those given up (too old, or too many at once), are listed by when they started; a
 * reply given up has its later deltas stored empty, never in clear without what came before.
 */
export class DeltaStreams {
  private readonly started: Map<string, number>
  private readonly givenUp: Map<string, number>
  /** Those this hub's memory holds. */
  private readonly live = new Map<string, MaskedStream>()

  constructor(
    private readonly store: StreamStore,
    private readonly now = Date.now,
  ) {
    this.started = new Map(store.load<[string, number][]>('delta-streams') ?? [])
    this.givenUp = new Map(store.load<[string, number][]>('delta-streams-given-up') ?? [])
  }

  /** The text to store for this delta of the reply `key`. */
  next(key: string, seq: number, text: string): string {
    if (this.givenUp.has(key)) return ''
    let stream = this.live.get(key)
    if (!stream && this.started.has(key)) {
      // Started before the hub slept: its state is saved, or it is given up.
      const state = this.store.load<StreamState>(`delta-stream:${key}`)
      if (!state) {
        this.giveUp(key, this.now())
        this.saveLists()
        return ''
      }
      stream = MaskedStream.from(state)
    }
    if (!stream) {
      this.start(key)
      stream = new MaskedStream()
    }
    this.live.set(key, stream)
    const out = stream.next(seq, text)
    this.store.save(`delta-stream:${key}`, stream.state)
    return out
  }

  /** Its message.done came: the reply is whole. */
  end(key: string) {
    this.live.delete(key)
    if (this.started.delete(key)) {
      this.store.save(`delta-stream:${key}`, undefined)
      this.saveLists()
    }
  }

  private start(key: string) {
    const now = this.now()
    for (const [id, at] of this.givenUp) if (now - at > GIVEN_UP_MS) this.givenUp.delete(id)
    for (const [id, at] of this.started)
      if (now - at > STREAM_MAX_MS || this.started.size >= STREAMS_MAX) this.giveUp(id, now)
      else break
    this.started.set(key, now)
    this.saveLists()
  }

  private giveUp(key: string, now: number) {
    this.started.delete(key)
    this.live.delete(key)
    this.store.save(`delta-stream:${key}`, undefined)
    this.givenUp.set(key, now)
  }

  private saveLists() {
    this.store.save('delta-streams', this.started.size ? [...this.started] : undefined)
    this.store.save('delta-streams-given-up', this.givenUp.size ? [...this.givenUp] : undefined)
  }
}

/**
 * Each message.delta's text masked as its reply's stream reads it (DeltaStreams), in seq order;
 * a message.done ends its stream. Other events as they are.
 */
export function maskDeltas<E extends { seq: number; event: { type: string } }>(
  streams: DeltaStreams,
  sessionId: string,
  events: E[],
): E[] {
  return events.map((e) => {
    const event = e.event as { type: string; id?: string; text?: string; teammateId?: string }
    if (event.type !== 'message.delta' && event.type !== 'message.done') return e
    const key = `${sessionId}:${event.teammateId ?? ''}:${event.id}`
    if (event.type === 'message.done') {
      streams.end(key)
      return e
    }
    const text = streams.next(key, e.seq, event.text ?? '')
    return text === event.text ? e : { ...e, event: { ...event, text } }
  })
}
