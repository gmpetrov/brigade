// Codex calls Brigade's tools from the scripts it runs (code mode's exec), which go on in the
// background after a second or so: the model then writes its reply and ends its turn, whatever a
// call still waits on. A ticket or question that paused the turn until a person answered, as it
// does on Claude Code, left Brigade waiting on a call Codex had given up. On Nov 17, a GPT-6.2
// turn sat 76 minutes after its X sign-in ticket was answered, until the member wrote again, and
// what the teammate wrote after opening that ticket and a second one never reached the thread.
// So on Codex they wait on nothing: the call returns at once, the ask stays open for the person
// (HarnessThread's `later`, as one set aside for a message in aside.ts), the thread waits on them
// once the turn is over, and their answer comes as a message of its own (answerLater).
import { tool, type Tool } from 'ai'
import type { WaitingCall } from './closed-turn.js'
import { askUserQuestions, ticketAsks, ticketRefused } from './events.js'
import { ASK_USER_TOOL, askUserTool, OPEN_TICKET_TOOL, openTicketTool } from './tools.js'

const STILL_OPEN =
  'It stays open for them: their answer comes as a message of its own once they give it. ' +
  'End your turn now, saying in a line what you wait on. Do not do what you asked about until ' +
  'they answer, and do not ask again.'

const INVALID_QUESTIONS =
  'Invalid questions: give 1 to 4, each with an id and a question (and options, if any, each with an id and a label).'

/** Open the ask; one that could not be kept is not open, and the teammate is told so. */
async function opened(open: (call: WaitingCall) => Promise<void>, call: WaitingCall) {
  try {
    await open(call)
  } catch (error) {
    throw new Error(
      `It could not be opened (${error instanceof Error ? error.message : String(error)}): nobody sees it. ` +
        'Say in your reply what you needed from the person instead.',
      { cause: error },
    )
  }
}

/** A tool's description, its first sentence (that it waits) replaced. */
function described(base: Pick<Tool, 'description'>, waits: string, instead: string) {
  const description = typeof base.description === 'string' ? base.description : ''
  if (!description.startsWith(waits)) throw new Error(`Unexpected description: ${description}`)
  return instead + description.slice(waits.length)
}

/**
 * Brigade's ticket and question tools for Codex: each opens its ask and returns at once.
 * `open` keeps the call, whose answer then comes as a message: the result goes back once it is
 * kept, so Codex hears it opened only then.
 */
export function asksWithoutWaiting(
  open: (call: WaitingCall) => Promise<void>,
  /**
   * App kinds closed to the thread's starter, as its latest spec says (spec.closedApps): a ticket
   * for one is refused. Read at each call: an agent made before a flag changed is kept.
   */
  closedApps: () => readonly string[] = () => [],
): Record<string, Tool> {
  return {
    [OPEN_TICKET_TOOL]: tool({
      inputSchema: openTicketTool.inputSchema,
      description: described(
        openTicketTool,
        'Open a ticket for a person and wait until they answer it.',
        'Open a ticket for a person. It does not wait for them: it opens, and their answer comes later as a message of its own.',
      ),
      execute: async (input, { toolCallId }) => {
        const refused = ticketRefused(input, closedApps())
        const ticket = ticketAsks(input)
        if (refused || !ticket) throw new Error(refused)
        await opened(open, { toolCallId, toolName: OPEN_TICKET_TOOL, input })
        return { opened: true, note: `Your ticket "${ticket.title}" is open. ${STILL_OPEN}` }
      },
    }),
    [ASK_USER_TOOL]: tool({
      inputSchema: askUserTool.inputSchema,
      description: described(
        askUserTool,
        'Ask the person who gave you this task one or more questions and wait for their answer.',
        'Ask the person who gave you this task one or more questions. It does not wait for them: their answer comes later as a message of its own.',
      ),
      execute: async (input, { toolCallId }) => {
        if (!askUserQuestions(input)) throw new Error(INVALID_QUESTIONS)
        await opened(open, { toolCallId, toolName: ASK_USER_TOOL, input })
        return { asked: true, note: `Your question is open. ${STILL_OPEN}` }
      },
    }),
  }
}
