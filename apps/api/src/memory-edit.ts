// Memory files as lines: what a thread's edit does to one, without the database,
// so it can be tested on its own.
import { MEMORY_MAX, type MemoryEdit } from '@brigade/contracts'

/** A line as edits compare it: no bullet, no surrounding space, any case. */
export const normalize = (line: string) =>
  line
    .replace(/^\s*[-*+]\s+/, '')
    .trim()
    .toLowerCase()

/**
 * Remove the lines a thread found wrong and add what it learned, keeping
 * everything else, people's edits included. Applied here so that two threads
 * ending together never overwrite each other.
 */
export function applyMemoryEdit(text: string, edit: MemoryEdit) {
  const remove = new Set(edit.remove.map(normalize))
  const all = text.split('\n')
  const lines = all.filter((l) => !l.trim() || !remove.has(normalize(l)))
  const removedLines = all.filter((l) => l.trim() && remove.has(normalize(l))).map((l) => l.trim())
  const present = new Set(lines.map(normalize))
  let out = lines.join('\n').replace(/\n*$/, '\n')
  const lastLine = lines.findLast((l) => l.trim()) ?? ''
  let added = 0
  let dropped = 0
  for (const line of edit.add) {
    const key = normalize(line)
    if (present.has(key)) continue
    const bullet = `- ${line.replace(/^\s*[-*+]\s+/, '').replace(/\s*\n\s*/g, ' ')}\n`
    // A list after a paragraph needs a blank line before it.
    const gap = added === 0 && !/^\s*[-*+]\s/.test(lastLine) && !out.endsWith('\n\n') ? '\n' : ''
    // A full file takes no more: said in the audit log, and the runner tidies files long before.
    if (out.length + gap.length + bullet.length > MEMORY_MAX) {
      dropped++
      continue
    }
    out += gap + bullet
    present.add(key)
    added++
  }
  return { text: out, added, removed: removedLines.length, removedLines, dropped }
}
