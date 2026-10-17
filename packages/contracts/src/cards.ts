// Cards a teammate writes at the end of its reply: buttons to answer with one
// click, or alternatives to pick from. Written in the reply rather than called
// as tools, the reply stays the last thing in the turn: nothing after it to
// summarize or to ask for again, and no request spent on a tool's result.
import { designFolderOf, designOptionsOf } from './design.js'
import { Choices, REPLY_ACTIONS, SUGGESTED_REPLY_MAX, SuggestedReplies } from './events.js'

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
 * person never sees its markup. Replies too long for a button are cut at a word,
 * and a button whose click could do more than send its words is left out (buttonText).
 * A tool call the teammate wrote out as text, at the end, is cut off too.
 */
export function replyCard(text: string): {
  text: string
  replies?: SuggestedReplies
  choices?: Choices
} {
  const blocks = [...text.matchAll(BLOCK)]
  const last = blocks.at(-1)
  if (!last) return { text: withoutWrittenCall(text) }
  const rest = withoutWrittenCall(text.replace(BLOCK, '').trim())
  if (last[1] === REPLIES_BLOCK) {
    const lines = last[2]!
      .split('\n')
      .map((line) =>
        line
          .trim()
          .replace(/^(?:[-*•]|\d+[.)])\s+/, '')
          .replace(/^["“]|["”]$/g, ''),
      )
      .filter(Boolean)
    const actions = lines.flatMap((line) => {
      const action = ACTION_LINE.exec(line)
      const label = action && buttonText(action[2]!)
      return action && label ? [{ action: action[1] as ReplyAction, label: clip(label) }] : []
    })
    const replies = safeReplies({
      replies: lines.filter((line) => !ACTION_LINE.test(line)),
      ...(actions.length ? { actions: actions.slice(0, 1) } : {}),
    })
    return { text: rest, ...(replies ? { replies } : {}) }
  }
  const choices = safeChoices(json(last[2]!))
  return { text: rest, ...(choices ? { choices: withDesigns(choices) } : {}) }
}

type ReplyAction = (typeof REPLY_ACTIONS)[number]
/** A replies line that is Brigade's action: `[merge] Merge #158`. */
const ACTION_LINE = new RegExp(`^\\[(${REPLY_ACTIONS.join('|')})\\]\\s*(.+)$`, 'i')

/** Controls, formatting characters and emoji variation selectors: dropped, as nothing shows of them. */
const HIDDEN = /(?![\u200c\u200d])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\ufe00-\ufe0f]/gu
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/u

/**
 * A button's words as a click sends them, as the person's own message: what shows
 * and nothing else. Null when a click could do more than say them: mention someone
 * (@), run a command (a leading / or !), or carry text nobody sees.
 */
export function buttonText(text: string): string | null {
  const shown = text.normalize('NFC').replace(HIDDEN, '').replace(/\s+/g, ' ').trim()
  if (!shown || shown.includes('@') || /^[/!]/.test(shown) || INVISIBLE.test(shown)) return null
  return shown
}

/** Replies as buttons show them, from a block or an older suggest_replies call: null when none is left. */
export function safeReplies(input: unknown): SuggestedReplies | null {
  const raw = input as { replies?: unknown; actions?: unknown } | null
  const replies = (Array.isArray(raw?.replies) ? raw.replies : [])
    .map((r) => (typeof r === 'string' ? buttonText(r) : null))
    .filter((r): r is string => r !== null)
    .map(clip)
    .slice(0, 3)
  const actions = Array.isArray(raw?.actions)
    ? raw.actions.flatMap((a: { action?: unknown; label?: unknown }) => {
        const label = typeof a?.label === 'string' ? buttonText(a.label) : null
        return label ? [{ action: a.action, label: clip(label) }] : []
      })
    : []
  const parsed = SuggestedReplies.safeParse({
    replies: replies.slice(0, 3 - Math.min(actions.length, 1)),
    ...(actions.length ? { actions } : {}),
  })
  return parsed.success ? parsed.data : null
}

/** Choices as their card shows them: options whose label a click could not send as is are left out. */
export function safeChoices(input: unknown): Choices | null {
  const parsed = Choices.safeParse(input)
  if (!parsed.success) return null
  const options = parsed.data.options.flatMap((o) => {
    const label = buttonText(o.label)
    return label ? [{ ...o, label }] : []
  })
  const kept = Choices.safeParse({ ...parsed.data, options })
  return kept.success ? kept.data : null
}

/**
 * The reply without a tool call the teammate wrote out as text at its end, which
 * nobody should see: from the line its opening tag starts, unless it sits in a code block.
 */
function withoutWrittenCall(text: string) {
  const call =
    /(?:^|\n)[ \t]*<(?:[a-z]+:)?(?:function_calls|invoke|parameter)\b[^>]*>[\s\S]*$/i.exec(text)
  if (!call) return text
  const fences = text.slice(0, call.index).match(/^```/gm)?.length ?? 0
  return fences % 2 === 0 ? text.slice(0, call.index).trimEnd() : text
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
