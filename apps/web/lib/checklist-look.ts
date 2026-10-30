// How a document's checklist line reads in the editor (components/document-checklist.ts),
// without touching its Markdown: the priority dot it starts with is hidden, and the note
// in italics it ends with goes on a line of its own, under the line's text.

/** A piece of a line's text, as the editor holds it. `aside`: not text of the line, such
 * as the marker of the work attached to it, which may follow the note. */
export type Piece = { text: string; italic: boolean; code: boolean; aside?: boolean }

/** The priority dots a line may start with (🔴 blocking, 🟠 before if possible, 🟢 after). */
const PRIORITY = /^\s*[🔴🟠🟡🟢]️?\s*/u

/**
 * `hide`: how many characters the priority dot takes at the start of the line (0 for none).
 * `note`: where the closing note starts and ends (before any marker beside it), or null:
 * the line ends in italics (code may sit inside), after text of its own.
 */
export function checklistLook(pieces: Piece[]): {
  hide: number
  note: { from: number; to: number } | null
} {
  const text = pieces.map((p) => p.text).join('')
  const hide = PRIORITY.exec(text)?.[0].length ?? 0

  let start = pieces.length
  while (start > 0) {
    const p = pieces[start - 1]!
    if (!(p.italic || p.code || p.aside || !p.text.trim())) break
    start--
  }
  // The note starts at its first words in italics, not at a space or code before them.
  while (start < pieces.length && !(pieces[start]!.italic && pieces[start]!.text.trim())) start++
  if (start === pieces.length) return { hide, note: null }

  const offset = (i: number) => pieces.slice(0, i).reduce((n, p) => n + p.text.length, 0)
  let end = pieces.length
  while (pieces[end - 1]!.aside) end--
  const from = offset(start)
  return { hide, note: text.slice(hide, from).trim() ? { from, to: offset(end) } : null }
}
