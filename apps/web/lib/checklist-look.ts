// How a document's checklist line reads in the editor (components/document-checklist.ts),
// without touching its Markdown: the notes in italics it ends with, each on a line of its
// own after a line break (Shift+Enter), read as notes. Italics in the line itself, even at
// its end, stay as they are. A long line that starts with a title (`Title: details…`) folds
// its details under the title, until someone opens it or edits it.

/** A piece of a line's text, as the editor holds it: a line break is `'\n'`. `aside`: not
 * text of the line, such as the marker of the work attached to it, which may follow the note. */
export type Piece = { text: string; italic: boolean; code: boolean; aside?: boolean }

/** The priority dot a line may start with (🔴 blocking, 🟠 before if possible, 🟢 after):
 * shown as written, but not text of its own that a note could go under. */
const PRIORITY = /^\s*[🔴🟠🟡🟢]️?\s*/u

/** Details shorter than this stay in the line: folding them would hide less than it shows. */
const DETAIL_MIN = 40
/** A title shorter than this is a label (`Note:`, `PR:`), not what the line is about. */
const TITLE_MIN = 3

/**
 * `note`: where the closing notes start (at the line break before the first) and end
 * (before any marker beside them), or null: the line does not end in a line break followed
 * by italics (code may sit inside), after text of its own.
 */
export function checklistLook(pieces: Piece[]): {
  note: { from: number; to: number } | null
  detail: { from: number; to: number } | null
} {
  const note = noteOf(pieces)
  return { note, detail: detailOf(pieces, note) }
}

type Range = { from: number; to: number }

function noteOf(pieces: Piece[]): Range | null {
  const text = pieces.map((p) => p.text).join('')
  const dot = PRIORITY.exec(text)?.[0].length ?? 0

  let start = pieces.length
  while (start > 0) {
    const p = pieces[start - 1]!
    if (!(p.italic || p.code || p.aside || !p.text.trim())) break
    start--
  }
  const offset = (i: number) => pieces.slice(0, i).reduce((n, p) => n + p.text.length, 0)
  const at = pieces.findIndex((p, i) => i >= start && p.text === '\n')
  if (at < 0 || !pieces.slice(at).some((p) => p.italic && p.text.trim())) return null

  let end = pieces.length
  while (pieces[end - 1]!.aside) end--
  const from = offset(at)
  return text.slice(dot, from).trim() ? { from, to: offset(end) } : null
}

/**
 * `detail`: what follows the line's title, from the colon that ends it to its notes (or the
 * marker of its work), or null. The title ends at the first colon followed by a space, outside
 * code (`https://…` and `11:20` have none); a line whose first colon is its `Done when:` folds
 * from there. Only details long enough to be worth folding, after a title of a few letters.
 */
function detailOf(pieces: Piece[], note: Range | null): Range | null {
  const text = pieces.map((p) => p.text).join('')
  const dot = PRIORITY.exec(text)?.[0].length ?? 0
  let end = note?.from ?? text.length
  if (!note) {
    let i = pieces.length
    while (i > 0 && pieces[i - 1]!.aside) end -= pieces[--i]!.text.length
  }
  let colon = -1
  let at = 0
  for (const p of pieces) {
    if (at >= end) break
    if (!p.code && !p.aside) {
      const found = /:(?=\s|$)/.exec(p.text.slice(0, end - at))
      if (found && at + found.index >= dot) {
        colon = at + found.index
        break
      }
    }
    at += p.text.length
  }
  if (colon < 0) return null
  const doneWhen = /\bdone when\s*$/i.exec(text.slice(dot, colon))
  const from = doneWhen ? dot + doneWhen.index : colon
  if (text.slice(dot, from).trim().length < TITLE_MIN) return null
  const rest = text
    .slice(colon + 1, end)
    .replace(/\s+/g, ' ')
    .trim()
  return rest.length >= DETAIL_MIN ? { from, to: end } : null
}
