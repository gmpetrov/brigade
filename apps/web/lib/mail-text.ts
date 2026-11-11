// A received mail's plain text, made readable in the Inbox (components/mail-body.tsx): lines a
// mail program cut at about 76 characters joined back into paragraphs, runs of blank lines
// shortened, a forwarded message's header block apart, and links, addresses and *bold* found.
// The text itself is not changed: teammates read it as it came.

/** A forwarded message: its header lines (From, Date, Subject, To…), then its own words. */
export type Forwarded = { label: string; headers: [string, string][]; body: MailText }

/** A mail's words: its own, then what it forwards. */
export type MailText = { text: string; forwarded: Forwarded | null }

export type Token =
  | { kind: 'text'; text: string }
  | { kind: 'link'; text: string; href: string }
  | { kind: 'bold'; text: string }

/** "---------- Forwarded message ---------", in the languages mail programs write it. */
const FORWARD =
  /^\s*-{3,}\s*((?:Forwarded|Original) message|Message transféré|Message d['’]origine|Weitergeleitete Nachricht|Mensaje reenviado|Messaggio inoltrato|Begin forwarded message:?)\s*-{0,}\s*$/i
/** Apple Mail's, with no dashes. */
const FORWARD_APPLE = /^\s*(Begin forwarded message|Début du message réexpédié)\s*:\s*$/i
const HEADER =
  /^\s*(From|To|Cc|Date|Sent|Subject|Reply-To|De|À|A|Objet|Envoyé|Von|An|Betreff|Datum|Para|Asunto|Fecha|Da|Oggetto|Data)\s*:\s?(.*)$/i

/** A line a mail program cut, at its width or a little under. */
const WRAP_MIN = 60
const WRAP_MAX = 80

export function readMailText(raw: string): MailText {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n')
  const at = lines.findIndex((l) => FORWARD.test(l) || FORWARD_APPLE.test(l))
  if (at < 0) return { text: tidy(lines), forwarded: null }
  const label = 'Forwarded message'
  // Its header lines, up to the first blank line; a line that continues one (an address put on
  // the next line, "<ada@example.com>") joins it.
  const headers: [string, string][] = []
  let i = at + 1
  while (i < lines.length && !lines[i]!.trim()) i++
  for (; i < lines.length && lines[i]!.trim(); i++) {
    const line = lines[i]!
    const header = HEADER.exec(line)
    if (header) headers.push([header[1]!, header[2]!.trim()])
    else if (headers.length) headers[headers.length - 1]![1] += ` ${line.trim()}`
    else break
  }
  // Not a header block after all: the words as they are.
  if (!headers.length) return { text: tidy(lines), forwarded: null }
  return {
    text: tidy(lines.slice(0, at)),
    forwarded: { label, headers, body: readMailText(lines.slice(i).join('\n')) },
  }
}

const FROM_HEADER = /^(From|De|Von|Da)$/i
const SUBJECT_HEADER = /^(Subject|Objet|Betreff|Asunto|Oggetto)$/i
const DATE_HEADER = /^(Date|Sent|Envoyé|Datum|Fecha|Data)$/i

/**
 * A forwarded message in one line, for its folded row: who sent it (the name, else the address),
 * its subject and when, each empty when its header is missing or unreadable.
 */
export function forwardSummary(forwarded: Forwarded): {
  from: string
  subject: string
  date: Date | null
} {
  const value = (name: RegExp) => forwarded.headers.find(([label]) => name.test(label))?.[1] ?? ''
  const fromValue = value(FROM_HEADER)
  const name = fromValue
    .replace(/<[^>]*>/g, '')
    .replace(/^["'\s]+|["'\s]+$/g, '')
    .trim()
  const address = /<([^>]+)>/.exec(fromValue)?.[1] ?? fromValue
  // Gmail writes "Fri, Oct 30, 2026 at 11:09 AM", which Date reads without its "at".
  const dateValue = value(DATE_HEADER).replace(/\s+at\s+/i, ' ')
  const time = dateValue ? Date.parse(dateValue) : NaN
  return {
    from: name || address.trim(),
    subject: value(SUBJECT_HEADER),
    date: Number.isNaN(time) ? null : new Date(time),
  }
}

/** Lines cut by a mail program joined back, at most one blank line in a row, no blank ends. */
function tidy(lines: string[]) {
  const joined = unwrap(lines)
  return joined
    .join('\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '')
}

/**
 * Joins lines a mail program cut at its width (Gmail's plain text cuts at about 76 characters):
 * only in a mail whose lines all fit that width, and only a line that would have gone past its
 * longest line with the next word. Quotes, lists and header lines stay as they are.
 */
export function unwrap(lines: string[]): string[] {
  const lengths = lines.map((l) => l.trimEnd().length)
  // A line longer than a mail program cuts at, with spaces in it (a long link has none): the mail
  // was not cut.
  if (lines.some((l, i) => lengths[i]! > WRAP_MAX && /\S\s+\S/.test(l.trim()))) return lines
  const width = Math.max(0, ...lengths.filter((n) => n <= WRAP_MAX))
  if (width < WRAP_MIN) return lines
  const out: string[] = []
  // The line last added as it came, before joining: the one the mail program cut.
  let last = ''
  for (const line of lines) {
    if (out.length && continues(last, line, width)) {
      out[out.length - 1] = `${out.at(-1)!.trimEnd()} ${line.trim()}`
    } else out.push(line)
    last = line
  }
  return out
}

const LIST = /^\s*([-*•>]|\d+[.)])\s/

/** Whether `line` goes on from `previous`, a line cut at `width`. */
function continues(previous: string, line: string, width: number) {
  if (!line.trim() || !previous.trim()) return false
  if (LIST.test(line) || /^\s*>/.test(previous) || HEADER.test(line) || HEADER.test(previous))
    return false
  const length = previous.trimEnd().length
  const word = line.trim().split(/\s/, 1)[0]!
  return length >= width * 0.6 && length + 1 + word.length > width - 4
}

const URL_RE = /\bhttps?:\/\/[^\s<>"]+/gi
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g
const BOLD_RE = /(^|[\s(])\*([^\s*](?:[^*\n]{0,80}?[^\s*])?)\*(?=$|[\s.,;:!?)])/g

/** Links (web and mail addresses) and *bold* in a piece of text, in order. */
export function tokens(text: string): Token[] {
  type Found = { start: number; end: number; token: Token }
  const found: Found[] = []
  for (const m of text.matchAll(URL_RE)) {
    // Punctuation after a link ends the sentence, not the link; a ")" closes it unless it opened one.
    let url = m[0]
    while (/[.,;:!?'"\]>]$/.test(url) || (url.endsWith(')') && !url.includes('('))) {
      url = url.slice(0, -1)
    }
    found.push({ start: m.index, end: m.index + url.length, token: link(url, url) })
  }
  for (const m of text.matchAll(EMAIL_RE)) {
    const start = m.index
    if (found.some((f) => start < f.end && start + m[0].length > f.start)) continue
    found.push({ start, end: start + m[0].length, token: link(m[0], `mailto:${m[0]}`) })
  }
  for (const m of text.matchAll(BOLD_RE)) {
    const start = m.index + m[1]!.length
    const end = start + m[2]!.length + 2
    if (found.some((f) => start < f.end && end > f.start)) continue
    found.push({ start, end, token: { kind: 'bold', text: m[2]! } })
  }
  found.sort((a, b) => a.start - b.start)
  const out: Token[] = []
  let at = 0
  for (const f of found) {
    if (f.start < at) continue
    if (f.start > at) out.push({ kind: 'text', text: text.slice(at, f.start) })
    out.push(f.token)
    at = f.end
  }
  if (at < text.length) out.push({ kind: 'text', text: text.slice(at) })
  return out
}

const link = (text: string, href: string): Token => ({ kind: 'link', text, href })

/** A link longer than this shows as its site rather than whole. */
const LINK_SHOWN_MAX = 48

/**
 * A link as a mail shows it: whole when short, else the site it leads to, since a newsletter's
 * tracked links (hundreds of characters each) would bury its words. A tracking redirect that
 * carries its destination in its path or query (awstrack.me/L0/https:%2F%2Fsite.com…) shows that
 * destination's site. The link itself still opens the URL as it came.
 */
export function shownLink(url: string): string {
  if (url.length <= LINK_SHOWN_MAX) return url
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  // Its destination, once or twice URL-encoded in it (the redirect's own host left out).
  let inner: string | undefined
  let rest = parsed.pathname + parsed.search
  for (let i = 0; i < 3 && !inner; i++) {
    inner = /https?:\/\/[^/?#&\s]+/i.exec(rest)?.[0]
    try {
      rest = decodeURIComponent(rest)
    } catch {
      break
    }
  }
  let host = parsed.hostname
  if (inner) {
    try {
      host = new URL(inner).hostname
    } catch {}
  }
  return host.replace(/^www\./i, '')
}
