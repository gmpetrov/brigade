// How a document's checklist line reads in the editor (components/document-checklist.ts),
// without touching its Markdown: the notes in italics it ends with, each on a line of its
// own after a line break (Shift+Enter), read as notes. Italics in the line itself, even at
// its end, stay as they are.

/** A piece of a line's text, as the editor holds it: a line break is `'\n'`. `aside`: not
 * text of the line, such as the marker of the work attached to it, which may follow the note. */
export type Piece = { text: string; italic: boolean; code: boolean; aside?: boolean }

/** The priority dot a line may start with (🔴 blocking, 🟠 before if possible, 🟢 after):
 * shown as written, but not text of its own that a note could go under. */
const PRIORITY = /^\s*[🔴🟠🟡🟢]️?\s*/u

/**
 * `note`: where the closing notes start (at the line break before the first) and end
 * (before any marker beside them), or null: the line does not end in a line break followed
 * by italics (code may sit inside), after text of its own.
 */
export function checklistLook(pieces: Piece[]): {
  note: { from: number; to: number } | null
} {
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
  if (at < 0 || !pieces.slice(at).some((p) => p.italic && p.text.trim())) return { note: null }

  let end = pieces.length
  while (pieces[end - 1]!.aside) end--
  const from = offset(at)
  return { note: text.slice(dot, from).trim() ? { from, to: offset(end) } : null }
}
