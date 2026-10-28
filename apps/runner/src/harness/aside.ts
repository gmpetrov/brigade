// A person writes to a teammate whose turn waits on their ticket or question, to ask about it
// rather than answer it (or another message comes in meanwhile). The ask stays open, and the
// message goes in now: as the waiting call's result, or, when that turn was closed
// (closed-turn.ts), as a message that says what became of the call. Their answer, whenever it
// comes, reaches the teammate as a message of its own. An approval is never set aside: the call
// it holds only goes on with a decision.
import type { WaitingCall } from './closed-turn.js'
import { ticketAsks } from './events.js'
import { OPEN_TICKET_TOOL } from './tools.js'

/** What the call asked, for the teammate: the ticket by its title, or the question. */
const asked = (call: Pick<WaitingCall, 'toolName' | 'input'>) =>
  call.toolName === OPEN_TICKET_TOOL
    ? `your ticket "${ticketAsks(call.input)?.title ?? 'A ticket'}"`
    : 'your question'

const STILL_OPEN =
  'Answer it, then end your turn: their answer comes as a message of its own once they give it. ' +
  'Do not ask again, and do not do what you asked for until they answer.'

/** The result of a waiting call set aside for a message (the person's, mostly), which it carries. */
export const asideResult = (call: WaitingCall, message: string) => ({
  type: 'tool-result' as const,
  toolCallId: call.toolCallId,
  toolName: call.toolName,
  output: {
    type: 'json' as const,
    value: {
      answered: false,
      note: `The person has not answered ${asked(call)} yet: it stays open for them. A message came in meanwhile (in \`message\`). ${STILL_OPEN}`,
      message,
    } as never,
  },
})

/** A message to a closed turn's calls (closeTurn), which come back interrupted. */
export const asideAfterRestart = (calls: WaitingCall[], message: string) =>
  `Your session restarted while you waited on the person, which cut off ${calls.map(asked).join(' and ')} above: ` +
  `it shows as interrupted, but it is still open for them, unanswered. A message came in meanwhile:\n\n${message}\n\n${STILL_OPEN}`

/** A person's answer to a call set aside earlier, as a message. */
export const answerLater = (call: Pick<WaitingCall, 'toolName' | 'input'>, answer: unknown) =>
  `The person answered ${asked(call)}, which stayed open while you answered a message. Their answer:\n\n` +
  `${JSON.stringify(answer)}\n\nCarry on from there, without asking again.`
