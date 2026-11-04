// Cards a teammate writes at the end of its reply: buttons to answer with one
// click, or alternatives to pick from, and the thread declared done. Written in
// the reply rather than called as tools, the reply stays the last thing in the
// turn: nothing after it to summarize or to ask for again, and no request spent
// on a tool's result.
import { designFolderOf, designOptionsOf } from './design.js'
import { Choices, REPLY_ACTIONS, SUGGESTED_REPLY_MAX, SuggestedReplies } from './events.js'

/** A fenced block of suggested replies, one per line. */
export const REPLIES_BLOCK = 'replies'
/** A fenced block of alternatives, as JSON (Choices). */
export const CHOICES_BLOCK = 'choices'
/**
 * A fenced block that declares the thread done, with one line on what was delivered
 * (docs/board.md): Brigade declares it as the turn ends, with no call to wait on.
 */
export const DONE_BLOCK = 'done'

/** The blocks that are cards: buttons or alternatives, read from the last one. */
const CARDS: ReadonlySet<string> = new Set([REPLIES_BLOCK, CHOICES_BLOCK])
const BLOCKS = [REPLIES_BLOCK, CHOICES_BLOCK, DONE_BLOCK]

/** A fenced code block at the top of a reply (fences). */
type Fence = {
  /** Its info string: `replies`, `choices`, `done`, a language… */
  info: string
  body: string
  /** From its opening fence's line to past its closing fence's line. */
  start: number
  end: number
  /** Still being written: no closing fence yet, it runs to the end of the text. */
  open: boolean
  /** Its opening fence's indent: a block Brigade reads has none (readable). */
  indent: number
}

/**
 * A reply's fenced code blocks at its top level, as Markdown reads them: a block inside another
 * (an example in a ```` fence) is that block's text, not a block of its own, so a card or a done
 * block quoted in an explanation is never read as one. Fences indented up to 3 spaces count here,
 * as they open and close blocks; which of them Brigade reads is `readable`'s to say.
 */
function fences(text: string): Fence[] {
  const found: Fence[] = []
  let open:
    | { char: string; length: number; info: string; start: number; body: number; indent: number }
    | undefined
  for (let at = 0; ;) {
    const next = text.indexOf('\n', at)
    const after = next < 0 ? text.length : next + 1
    const fence = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(
      text.slice(at, next < 0 ? undefined : next).replace(/\r$/, ''),
    )
    const [indent, marks, rest] = fence ? [fence[1]!, fence[2]!, fence[3]!] : ['', '', '']
    if (!open) {
      // A backtick fence's info string has no backtick in it.
      if (fence && !(marks[0] === '`' && rest.includes('`')))
        open = {
          char: marks[0]!,
          length: marks.length,
          info: rest.trim(),
          start: at,
          body: after,
          indent: indent.length,
        }
    } else if (fence && marks[0] === open.char && marks.length >= open.length && !rest.trim()) {
      found.push({
        info: open.info,
        body: text.slice(open.body, at),
        start: open.start,
        end: after,
        open: false,
        indent: open.indent,
      })
      open = undefined
    }
    if (next < 0) break
    at = after
  }
  if (open)
    found.push({
      info: open.info,
      body: text.slice(Math.min(open.body, text.length)),
      start: open.start,
      end: text.length,
      open: true,
      indent: open.indent,
    })
  return found
}

/**
 * A block Brigade reads, a card or a done block: one whose fence starts its line. Indented, it
 * may be an item's in a list (`- Example:` then the block under it), which Markdown reads as part
 * of that item, not of the reply's end: an example, never read. At the start of its line, a fence
 * belongs to no list.
 */
const readable = (block: Fence) => block.indent === 0

/** The text without these blocks. */
function without(text: string, blocks: Fence[]) {
  let rest = ''
  let at = 0
  for (const block of [...blocks].sort((a, b) => a.start - b.start)) {
    rest += text.slice(at, block.start)
    at = block.end
  }
  return rest + text.slice(at)
}

/**
 * A reply with its card taken out: the last replies or choices block it has,
 * wherever it is. A block that does not read is dropped all the same, so the
 * person never sees its markup. Replies too long for a button are cut at a word,
 * and a button whose click could do more than send its words is left out (buttonText).
 * A tool call the teammate wrote out as text, at the end, is cut off too. A done block
 * at the reply's very end (nothing after it but cards) comes out as `done`, its line (empty when
 * it has none: doneLine finds one); one elsewhere is an example, and stays. Blocks inside
 * another code block are its text (fences).
 */
export function replyCard(text: string): {
  text: string
  replies?: SuggestedReplies
  choices?: Choices
  done?: string
} {
  const blocks = fences(text).filter((block) => !block.open && readable(block))
  const cards = blocks.filter((block) => CARDS.has(block.info))
  const done = blocks.findLast(
    (block) =>
      block.info === DONE_BLOCK &&
      !without(
        text,
        cards.filter((card) => card.start >= block.end),
      )
        .slice(block.end)
        .trim(),
  )
  const taken = done ? [...cards, done] : cards
  // Taken out, the blocks leave their reply trimmed; a reply without one stays as written.
  const rest = taken.length ? without(text, taken).trim() : text
  const read = cardOf(withoutWrittenCall(rest), cards.at(-1))
  return done ? { ...read, done: done.body.replace(/\s+/g, ' ').trim() } : read
}

/** The reply, its cards already taken out, and what its last card reads as. */
function cardOf(
  rest: string,
  last: Fence | undefined,
): { text: string; replies?: SuggestedReplies; choices?: Choices } {
  if (!last) return { text: rest }
  if (last.info === REPLIES_BLOCK) {
    const lines = last.body
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
  const choices = safeChoices(json(last.body))
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
  // An action this version does not know (from a newer runner) is left out, not its replies.
  const actions = Array.isArray(raw?.actions)
    ? raw.actions.flatMap((a: { action?: unknown; label?: unknown }) => {
        const label = typeof a?.label === 'string' ? buttonText(a.label) : null
        const known = REPLY_ACTIONS.includes(a?.action as ReplyAction)
        return label && known ? [{ action: a.action, label: clip(label) }] : []
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

/**
 * What a reply still being written shows: none of a card it has begun, even its fence half
 * written. A block it opened inside another code block is that block's text, and shows.
 */
export function withoutCard(text: string) {
  const last = fences(text).at(-1)
  const writing =
    last?.open &&
    readable(last) &&
    (BLOCKS.includes(last.info) ||
      // Its opening fence still being written: "```rep".
      (!text.slice(last.start).includes('\n') &&
        BLOCKS.some((block) => block.startsWith(last.info))))
  return replyCard(writing ? text.slice(0, last.start) : text).text.trimEnd()
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
