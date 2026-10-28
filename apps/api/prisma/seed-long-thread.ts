// A long thread for the sample workspace: 40 messages from a member over a few days, each
// answered after many steps, about 6,000 events in all. It opens on its latest page, and
// its timeline (apps/web/components/thread-timeline.tsx) jumps to messages not loaded.
import { randomBytes } from 'node:crypto'
import type { AgentEvent } from '@brigade/contracts'

const id = () => randomBytes(8).toString('hex')

/** An event as the runner sends it, without its time. */
type Draft = {
  [T in AgentEvent['type']]: Omit<Extract<AgentEvent, { type: T }>, 'at'>
}[AgentEvent['type']]

export const LONG_THREAD_TITLE = 'Rebuild the checkout flow'

const ASKS = [
  'Let’s rebuild the checkout flow. Start by mapping every step a customer goes through today.',
  'Which of those steps lose the most people? Use the analytics export in the library.',
  'Draft a one-page plan: what changes, in what order, and how we measure it.',
  'Good. Start with the cart page: show the delivery date before the payment step.',
  'The date is wrong for orders placed after 5pm. Can you check the cut-off logic?',
  'Add a test for the weekend case too.',
  'Now the address form: autocomplete the street from the postcode.',
  'It feels slow on mobile. Profile it and tell me where the time goes.',
  'Debounce the lookup and cache the last ten postcodes.',
  'Make the error message friendlier when the postcode is unknown.',
  'Move on to payment: offer Apple Pay when the browser supports it.',
  'What happens if the payment sheet is cancelled halfway?',
  'Keep the cart as it was and show a short note. No modal.',
  'Add the order summary to the right column on desktop.',
  'The summary overlaps the footer on small laptops. Fix the layout.',
  'Write the copy for the confirmation page, friendly but short.',
  'Shorter. Two sentences at most.',
  'Send the confirmation email from the new template.',
  'The email preview is missing the delivery date. Add it.',
  'Run the whole flow end to end and list anything broken.',
  'Fix the three bugs you found, one commit each.',
  'Open a pull request with everything so far.',
  'The reviewer asks for smaller components. Split the payment step.',
  'Rename `CheckoutThing` to `PaymentStep` everywhere.',
  'Can we keep the old flow behind a flag for a week?',
  'Add the flag to the admin settings, off by default.',
  'Turn it on for 10% of visitors and log which flow each order used.',
  'After two days, compare conversion between the two flows.',
  'The new flow wins on desktop but not on mobile. Why?',
  'Make the payment button sticky on mobile.',
  'Check accessibility: keyboard, screen reader labels, contrast.',
  'Fix what you found, then rerun the checks.',
  'Translate the new copy into French and German.',
  'The German button text is too long. Find a shorter one.',
  'Update the help center article about checkout.',
  'Write release notes for the team, five bullet points.',
  'Roll the new flow out to everyone.',
  'Remove the old flow and its flag.',
  'Summarise what we shipped and what we learned.',
  'Thanks! Anything we should watch over the next week?',
]

/** Steps of a turn: reading, searching, editing and running, as a teammate does. */
function steps(turn: number, count: number): Draft[] {
  const out: Draft[] = []
  for (let k = 0; k < count; k++) {
    const toolCallId = `call_${id()}`
    const kind = k % 4
    const [toolName, input, output] =
      kind === 0
        ? ['Read', { file_path: `src/checkout/step-${k % 7}.tsx` }, `// step ${k % 7}`]
        : kind === 1
          ? ['Grep', { pattern: 'checkout', path: 'src' }, `src/checkout/step-${k % 7}.tsx`]
          : kind === 2
            ? ['Edit', { file_path: `src/checkout/step-${k % 7}.tsx` }, 'Edited']
            : ['Bash', { command: 'pnpm test checkout' }, `${20 + turn} passed`]
    out.push({ type: 'tool.started', toolCallId, toolName, input })
    out.push({ type: 'tool.finished', toolCallId, toolName, output, isError: false })
  }
  return out
}

function answer(turn: number, ask: string) {
  return [
    `Done: ${ask.replace(/[.?!]+$/, '').toLowerCase()}.`,
    '',
    `- Changed ${2 + (turn % 5)} files under \`src/checkout/\`.`,
    `- Tests: ${20 + turn} passed.`,
    turn % 3 === 0 ? '- One thing to decide: see the note above the summary.' : '',
    '',
    'Tell me what to look at next.',
  ]
    .filter((line, i, all) => line !== '' || all[i - 1] !== '')
    .join('\n')
}

/** The thread's events, oldest first. */
export function longThreadEvents(teammateId: string, accountId: string, memberId: string): Draft[] {
  return ASKS.flatMap((ask, turn): Draft[] => [
    { type: 'message.user', text: ask, memberId },
    { type: 'turn.started', teammateId, accountId, turnId: id() },
    ...steps(turn, 60 + ((turn * 17) % 30)).map((s) => ({ ...s, teammateId })),
    { type: 'message.done', id: id(), text: answer(turn, ask), teammateId },
    { type: 'turn.completed', finishReason: 'stop', teammateId },
  ])
}
