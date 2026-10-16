// Cards a teammate writes at the end of its reply: buttons to answer with one
// click, or alternatives to pick from. Written in the reply rather than called
// as tools, the reply stays the last thing in the turn: nothing after it to
// summarize or to ask for again, and no request spent on a tool's result.
import { designFolderOf, designOptionsOf } from './design.js'
import { Choices, SUGGESTED_REPLY_MAX, SuggestedReplies } from './events.js'

/** A fenced block of suggested replies, one per line. */
export const REPLIES_BLOCK = 'replies'
/** A fenced block of alternatives, as JSON (Choices). */
export const CHOICES_BLOCK = 'choices'

const BLOCK = /```(replies|choices)[ \t]*\r?\n([\s\S]*?)```[ \t]*(?:\r?\n|$)/g
/** From a block's opening fence to the end of the text, while it is still being written. */
const OPENED = /\n?```(?:replies|choices)\b[\s\S]*$/

/**
 * A reply with its card taken out: the last replies or choices block it has,
 * wherever it is. A block that does not read is dropped all the same, so the
 * person never sees its markup. Replies too long for a button are cut at a word.
 */
export function replyCard(text: string): {
  text: string
  replies?: SuggestedReplies
  choices?: Choices
} {
  const blocks = [...text.matchAll(BLOCK)]
  const last = blocks.at(-1)
  if (!last) return { text }
  const rest = text.replace(BLOCK, '').trim()
  if (last[1] === REPLIES_BLOCK) {
    const replies = SuggestedReplies.safeParse({
      replies: last[2]!
        .split('\n')
        .map((line) =>
          clip(
            line
              .trim()
              .replace(/^(?:[-*•]|\d+[.)])\s+/, '')
              .replace(/^["“]|["”]$/g, ''),
          ),
        )
        .filter(Boolean)
        .slice(0, 3),
    })
    return { text: rest, ...(replies.success ? { replies: replies.data } : {}) }
  }
  const choices = Choices.safeParse(json(last[2]!))
  return { text: rest, ...(choices.success ? { choices: withDesigns(choices.data) } : {}) }
}

/** What a reply still being written shows: none of a card it has begun, even its fence half written. */
export function withoutCard(text: string) {
  const shown = replyCard(text).text.replace(OPENED, '')
  const last = shown.slice(shown.lastIndexOf('\n') + 1)
  const fence =
    last.startsWith('```') &&
    [REPLIES_BLOCK, CHOICES_BLOCK].some((block) => `\`\`\`${block}`.startsWith(last))
  return (fence ? shown.slice(0, shown.length - last.length) : shown).trimEnd()
}

/** A reply for a button: trimmed, and cut at a word when it is too long. */
function clip(line: string) {
  const text = line.trim()
  if (text.length <= SUGGESTED_REPLY_MAX) return text
  const cut = text.slice(0, SUGGESTED_REPLY_MAX + 1)
  const space = cut.lastIndexOf(' ')
  return (space > 0 ? cut.slice(0, space) : cut.slice(0, SUGGESTED_REPLY_MAX)).trim()
}

function json(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Options keep their designs only when all of them are designs saved in one
 * options folder, as a pick moves them; otherwise they are offered without pictures.
 */
function withDesigns(choices: Choices): Choices {
  const designs = choices.options.map((o) => o.design?.replace(/\/+$/, ''))
  if (designs.every((d) => d === undefined)) return choices
  const folders = new Set(
    designs.map((d) => (d && designFolderOf(d) === d ? designOptionsOf(d) : undefined)),
  )
  if (!folders.has(undefined) && folders.size === 1) return choices
  return { ...choices, options: choices.options.map(({ design: _, ...option }) => option) }
}
