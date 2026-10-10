/**
 * Mentions inside message text. The composer writes them as `@[Label](kind:id)`:
 * a teammate reads the label and the reference; the dashboard renders a chip.
 * A member mentioning a credential lets the thread's teammate use it there.
 * A repository's id is its owner/name, for the teammate to check out.
 */
export const MENTION_KINDS = [
  'teammate',
  'connection',
  'thread',
  'computer',
  'credential',
  'repository',
] as const
export type MentionKind = (typeof MENTION_KINDS)[number]

/** Kinds renamed since, still in older messages: `project` became `repository`. */
const RENAMED_KINDS: Record<string, MentionKind> = { project: 'repository' }
/** Every kind a mention may carry, current or renamed, for a regular expression. */
export const MENTION_KIND_PATTERN = [...MENTION_KINDS, ...Object.keys(RENAMED_KINDS)].join('|')
/** The current kind for one written in a message. */
export const mentionKind = (kind: string) => RENAMED_KINDS[kind] ?? (kind as MentionKind)

export type Mention = { kind: MentionKind; id: string; label: string }

const MENTION = new RegExp(`@\\[([^\\]\\n]+)\\]\\((${MENTION_KIND_PATTERN}):([^)\\s]+)\\)`, 'g')

export function formatMention({ kind, id, label }: Mention) {
  return `@[${label.replace(/[\]\n]/g, ' ').trim()}](${kind}:${id})`
}

/** Text and mentions in order, for rendering. */
export function parseMentions(text: string): (string | Mention)[] {
  const parts: (string | Mention)[] = []
  let last = 0
  for (const m of text.matchAll(MENTION)) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    parts.push({ label: m[1]!, kind: mentionKind(m[2]!), id: m[3]! })
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

/** Mentions reduced to their labels, for titles and previews. */
export const mentionsToText = (text: string) =>
  text.replace(MENTION, (_, label: string, kind: string) =>
    kind === 'teammate' ? `@${label}` : label,
  )

/** Ids of the mentions of one kind in a text. */
export const mentionedIds = (text: string, kind: MentionKind) =>
  parseMentions(text).flatMap((p) => (typeof p !== 'string' && p.kind === kind ? [p.id] : []))
