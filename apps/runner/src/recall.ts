// Memory past what the instructions file holds (MEMORY_CHARS per memory), brought
// into a turn when it bears on the message: its lines ranked against the message
// (BM25, no model call), a few per turn, never one twice in a harness session.
// Below the limit nothing is left out, and nothing is recalled.

/** Lines brought into one turn, and their length. */
const MAX_LINES = 8
const MAX_CHARS = 3_000
/** What one harness session is brought in all, so a long thread does not fill up with memory. */
export const SESSION_CHARS = 20_000
/** A line scoring below this share of the best one is left out: a stray shared word. */
const FLOOR = 0.35
const K1 = 1.2
const B = 0.75

const STOP = new Set(
  (
    'the and for are but not you all any can had her was one our out has have this that with from they ' +
    'will would there their what when which who how about into than then them these those your its also ' +
    'les des une est pas pour par sur dans avec que qui quoi ses son mon mes tes nos vos leur elle ils ' +
    'nous vous mais donc car comme tout tous fait faire plus moins sans sous entre cette ces aux'
  ).split(' '),
)

/** A memory's lines that its first `limit` characters do not show whole. */
export function beyondShown(text: string, limit: number) {
  if (text.length <= limit) return []
  const lines: string[] = []
  let at = 0
  for (const line of text.split('\n')) {
    const end = at + line.length
    if (end > limit && line.trim()) lines.push(line.trim())
    at = end + 1
  }
  return lines
}

function terms(text: string) {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 3 && !STOP.has(t))
}

/**
 * The lines of `candidates` that bear on `message`, best first, skipping those in
 * `already` (and adding the picked ones to it). Empty when none clearly does.
 */
export function pickLines(candidates: string[], message: string, already: Set<string>) {
  const query = [...new Set(terms(message))]
  const docs = [...new Set(candidates)]
    .filter((c) => !already.has(c))
    .map((line) => ({
      line,
      terms: terms(line),
    }))
  if (query.length === 0 || docs.length === 0) return []
  const avg = docs.reduce((n, d) => n + d.terms.length, 0) / docs.length || 1
  const df = new Map<string, number>()
  for (const d of docs) for (const t of new Set(d.terms)) df.set(t, (df.get(t) ?? 0) + 1)
  const scored = docs
    .map((d) => {
      let score = 0
      for (const q of query) {
        const tf = d.terms.filter((t) => t === q).length
        if (tf === 0) continue
        const n = df.get(q) ?? 0
        const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5))
        score += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * d.terms.length) / avg))
      }
      return { line: d.line, score }
    })
    .filter((d) => d.score > 0)
    .sort((a, b) => b.score - a.score)
  const top = scored[0]?.score ?? 0
  const spent = [...already].reduce((n, l) => n + l.length, 0)
  const picked: string[] = []
  let chars = 0
  for (const { line, score } of scored) {
    if (score < top * FLOOR || picked.length >= MAX_LINES) break
    if (chars + line.length > MAX_CHARS || spent + chars + line.length > SESSION_CHARS) break
    picked.push(line)
    chars += line.length
  }
  for (const line of picked) already.add(line)
  return picked
}

/** What a turn is told of its recalled lines; empty when there are none. */
export function recalledBlock(lines: string[]) {
  if (lines.length === 0) return ''
  return [
    '<recalled-memory>',
    'Lines from memory that your instructions file had no room for, picked for this message. ' +
      'Background, true when they were written: check one before you rely on it.',
    ...lines.map((l) => (l.startsWith('- ') ? l : `- ${l}`)),
    '</recalled-memory>',
  ].join('\n')
}
