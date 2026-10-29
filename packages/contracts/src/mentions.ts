import { previewElementsToText } from './preview-elements.js'

/**
 * Mentions inside message text. The composer writes them as `@[Label](kind:id)`:
 * a teammate reads the label and the reference; the dashboard renders a chip.
 * A member mentioning a credential lets the thread's teammate use it there.
 * A repository's id is owner/name, for the teammate to check out. A library
 * file (`document`) is labelled with its library path; a design's id and label are
 * its folder's library path ("acme/pricing.design"); a design system's id is its
 * library folder ("design-systems/acme") and its label its name. A project's id
 * is its Project id. An email's id is its mail's (email_read's), and its label its sender and
 * subject. Messages from before projects named a repository as
 * `project` with an owner/name id; those still render as repositories.
 */
export const MENTION_KINDS = [
  'teammate',
  'connection',
  'thread',
  'computer',
  'credential',
  'repository',
  'document',
  // Before `design`, which it starts with.
  'design-system',
  'design',
  'project',
  // A mail of the Inbox: its id is the MailMessage's, which email_read takes.
  'email',
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

/** Mentions (and elements picked in a preview) reduced to their labels, for titles and previews. */
export const mentionsToText = (text: string) =>
  previewElementsToText(text).replace(MENTION, (_, label: string, kind: MentionKind) =>
    kind === 'teammate' ? `@${label}` : label,
  )

/**
 * Text from outside (an email) with its mentions made plain: put in a member's message, it
 * summons nobody and grants nothing. Again until none is left, since a label may hold the start
 * of another.
 */
export function unmention(text: string) {
  let out = text
  while (
    out !==
    (out = out.replace(
      MENTION,
      (_, label: string, kind: string, id: string) => `${label} (${kind}: ${id})`,
    ))
  );
  return out
}

/** A `project` mention from before projects: its id is a repository (owner/name). */
export const isLegacyProjectMention = (m: { kind: MentionKind; id: string }) =>
  m.kind === 'project' && m.id.includes('/')

/** Ids of the mentions of one kind in a text. */
export const mentionedIds = (text: string, kind: MentionKind) =>
  parseMentions(text).flatMap((p) => (typeof p !== 'string' && p.kind === kind ? [p.id] : []))
