import type { Ask, AskReply, TicketAnswer } from './events.js'

/**
 * What a teammate is told when a person hands a thread back: their note and
 * the files they changed. The runner writes it as the person's message; the
 * dashboard reads it back for its card, rather than showing the teammate's prompt.
 */

const HEAD = 'A person took over this thread and has now handed it back to you.'
const NOTE = 'Their note: '
const FILES = 'Files changed while they had control:\n'
const NO_FILES = 'They changed no files in this directory.'

export type Handback = { note: string; files: string[] }

export function handbackMessage({ note, files }: Handback) {
  return [
    HEAD,
    note.trim() && `${NOTE}${note.trim()}`,
    files.length > 0 ? `${FILES}${files.map((f) => `- ${f}`).join('\n')}` : NO_FILES,
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** The note and files of a hand back message, or null for any other message. */
export function handbackNote(text: string): Handback | null {
  if (!text.startsWith(`${HEAD}\n\n`)) return null
  let rest = text.slice(HEAD.length + 2)
  let files: string[] = []
  if (rest === NO_FILES || rest.endsWith(`\n\n${NO_FILES}`)) {
    rest = rest.slice(0, -NO_FILES.length)
  } else {
    // The note comes before the files, and may hold blank lines of its own.
    const at = rest.startsWith(FILES) ? 0 : rest.lastIndexOf(`\n\n${FILES}`)
    if (at < 0) return null
    files = rest
      .slice(at + (at === 0 ? 0 : 2) + FILES.length)
      .split('\n')
      .map((line) => line.replace(/^- /, ''))
      .filter(Boolean)
    rest = rest.slice(0, at)
  }
  rest = rest.trim()
  if (rest && !rest.startsWith(NOTE)) return null
  return { note: rest.slice(NOTE.length).trim(), files }
}

/**
 * Handing back with a ticket open whose every ask left is something to do in the teammate's
 * browser: the hand back is its answer, done, with the person's note. `given`: the asks the
 * person answered already (kept in their browser until the whole ticket is sent). Else
 * undefined, and the ticket stays open.
 */
export function handbackAnswer(
  asks: Ask[],
  note: string,
  given: Record<string, AskReply> = {},
): TicketAnswer | undefined {
  const replied = asks.filter((a) => given[a.id]?.type === a.type)
  const left = asks.filter((a) => !replied.includes(a))
  if (left.length === 0 || !left.every((a) => a.type === 'action' && a.browser)) return undefined
  const done = {
    type: 'action' as const,
    done: true,
    ...(note.trim() ? { note: note.trim() } : {}),
  }
  return {
    action: 'answered',
    replies: Object.fromEntries([
      ...replied.map((a) => [a.id, given[a.id]!]),
      ...left.map((a) => [a.id, done]),
    ]),
  }
}
