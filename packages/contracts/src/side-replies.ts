// Side replies (people see them as an "Aside"). A person writes while their teammate's turn
// runs: a copy of the teammate's conversation answers them now, and says what becomes of the
// message: settled by that answer, given to the running turn, or left for after it. The turn
// itself is never interrupted. docs/side-replies.md.

/**
 * What becomes of a message answered on the side. answer: the side reply settles it, and its
 * own turn never comes. steer: it is given to the running turn (after STEER_DELAY_MS, unless
 * the person keeps it). queue: it waits for the turn to end, as any message would.
 */
export type SideRoute = 'answer' | 'steer' | 'queue'

/** How long a message the side reply passes to the running turn waits, so its sender can keep it. */
export const STEER_DELAY_MS = 6_000

/** The longest a side reply may take before the message just waits its turn. */
export const SIDE_REPLY_TIMEOUT_MS = 120_000

const ROUTE_LINE = /^[ \t>*_`]*ROUTE[ \t]*:[ \t]*\**[ \t]*(answer|steer|queue)\b.*$/gim

/**
 * What the copy of the conversation is told: the person's message, that it can only read, and
 * how to end its reply. Its own instructions (the teammate's, with its memory) still hold.
 */
export function sidePrompt(input: { name: string; text: string }) {
  const name = input.name.replace(/["<>\n]/g, '')
  const text = input.text.replace(/<(\/?message\b)/gi, '‹$1')
  return [
    `${name} wrote to you while your turn is still running. This is a copy of your conversation, made to answer them on the side: your turn goes on without you, and nothing you do here reaches it. The step your turn is on may show as interrupted here: it is not, it still runs.`,
    `<message from="${name}" kind="person">\n${text}\n</message>`,
    'Answer them in a few lines, from what you already know. You may read files (Read, Glob, Grep) and nothing else: here you change nothing, run nothing and use none of Brigade’s tools. Do not promise what your turn will do, except as below.',
    'Then decide what happens to their message, and say it on the last line, alone:\n' +
      '- `ROUTE: answer` when your answer settles it: a question, a remark, news. Your turn is told of this exchange when it next starts.\n' +
      '- `ROUTE: steer` when it changes the work your turn is doing now (a correction, an instruction, a detail it needs): it is given to your turn at its next step. Say in a few words that you pass it on.\n' +
      '- `ROUTE: queue` when it asks for new work, separate from what your turn is doing: it waits until your turn ends. Say so in a few words.',
  ].join('\n\n')
}

/**
 * The reply and the route it chose: its last ROUTE line, taken out of the text. Without one,
 * the message waits for the turn to end, as it would have without a side reply.
 */
export function parseSideReply(text: string): { text: string; route: SideRoute } {
  const lines = [...text.matchAll(ROUTE_LINE)]
  const last = lines.at(-1)
  const route = (last?.[1]?.toLowerCase() as SideRoute | undefined) ?? 'queue'
  const reply = text
    .replace(ROUTE_LINE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { text: reply, route }
}

/**
 * What the teammate is told at the start of its next turn of a message its copy answered on
 * the side: the message and the answer, so it knows what the person was told.
 */
export function sideNote(input: { name: string; text: string; reply: string }) {
  return (
    `While you worked, ${input.name} wrote to you on the side:\n\n${input.text}\n\n` +
    `A copy of your conversation answered them, as you:\n\n${input.reply}\n\n` +
    'That settled it: do nothing more about it unless they ask again.'
  )
}
