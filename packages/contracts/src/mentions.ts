/**
 * Mentions inside message text. The composer writes them as `@[Label](kind:id)`:
 * a teammate reads the label and the reference; the dashboard renders a chip.
 * A member mentioning a credential lets the thread's teammate use it there.
 * A repository's id is owner/name, for the teammate to check out. A library
 * file (`document`) is labelled with its library path. `project` is
 * how messages named one before; they still render.
 */
export const MENTION_KINDS = [
  'teammate',
  'connection',
  'thread',
  'computer',
  'credential',
  'repository',
  'document',
  'project',
] as const
export type MentionKind = (typeof MENTION_KINDS)[number]

export type Mention = { kind: MentionKind; id: string; label: string }

const MENTION = new RegExp(`@\\[([^\\]\\n]+)\\]\\((${MENTION_KINDS.join('|')}):([^)\\s]+)\\)`, 'g')

export function formatMention({ kind, id, label }: Mention) {
  return `@[${label.replace(/[\]\n]/g, ' ').trim()}](${kind}:${id})`
}

/** Text and mentions in order, for rendering. */
export function parseMentions(text: string): (string | Mention)[] {
  const parts: (string | Mention)[] = []
  let last = 0
  for (const m of text.matchAll(MENTION)) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    parts.push({ label: m[1]!, kind: m[2] as MentionKind, id: m[3]! })
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

/** Mentions reduced to their labels, for titles and previews. */
export const mentionsToText = (text: string) =>
  text.replace(MENTION, (_, label: string, kind: MentionKind) =>
    kind === 'teammate' ? `@${label}` : label,
  )

/** Ids of the mentions of one kind in a text. */
export const mentionedIds = (text: string, kind: MentionKind) =>
  parseMentions(text).flatMap((p) => (typeof p !== 'string' && p.kind === kind ? [p.id] : []))
