// Which guess at a person's next message their message box shows (message.suggested).
import { z } from 'zod'
import { PROPOSE_TEAM_TOOL } from './chief.js'
import { OFFER_CHOICES_TOOL, SUGGEST_REPLIES_TOOL, type AgentEvent } from './events.js'
import { bareToolName } from './thread-history.js'

/** A member turns the suggestions in their message box on or off (Member.suggestions). */
export const SetSuggestions = z.object({ suggestions: z.boolean() })

/** Events that may come after a guess and leave it standing: nothing anyone said or did. */
const QUIET: ReadonlySet<AgentEvent['type']> = new Set([
  'usage.updated',
  'raw',
  'preview.changed',
  'repositories.changed',
  'message.cancelled',
])

/** Cards with answers of their own: the person picks one there rather than write. */
const ANSWER_CARDS: ReadonlySet<string> = new Set([
  SUGGEST_REPLIES_TOOL,
  OFFER_CHOICES_TOOL,
  PROPOSE_TEAM_TOOL,
])

/**
 * The latest guess, for the member who wrote the thread's last message: where it is
 * in `events` and its text. None once anything happened after it, when someone else
 * (or Brigade) wrote last, or when the turn it follows asked something or offered
 * answers to pick (reply pills, choices, a team), which come first.
 */
export function suggestionFor(
  events: readonly AgentEvent[],
  memberId: string | null,
): { index: number; text: string } | null {
  if (!memberId) return null
  let i = events.length - 1
  while (i >= 0 && QUIET.has(events[i]!.type)) i--
  const guess = events[i]
  if (guess?.type !== 'message.suggested' || !guess.text.trim()) return null
  for (let j = i - 1; j >= 0; j--) {
    const event = events[j]!
    if (event.type === 'message.user')
      return event.memberId === memberId ? { index: i, text: guess.text.trim() } : null
    if (
      event.type === 'question.asked' ||
      event.type === 'ticket.opened' ||
      event.type === 'approval.requested' ||
      (event.type === 'tool.started' && ANSWER_CARDS.has(bareToolName(event.toolName)))
    )
      return null
  }
  return null
}
