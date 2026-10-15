// Naming a new thread: the prompt for a short harness run on its first
// message, and reading its answer. The API keeps the title unless a person renamed it.
import { type HarnessId, mentionsToText } from '@brigade/contracts'

/** A small, fast model per harness: a title is a few words. Not a member's setting. */
export const TITLE_MODEL: Record<HarnessId, string> = {
  claude_code: 'claude-haiku-5-5',
  codex: 'gpt-6-luna',
}

/** How much of the first message a title run reads. */
const MESSAGE_CHARS = 4_000
const TITLE_CHARS = 60

export function titlePrompt(text: string) {
  const message = mentionsToText(text).trim()
  return [
    'Write a title for a conversation that starts with the message below: 2 to 6 words saying what it is about, in the language of the message.',
    'Reply with only the title: no quotes, no trailing period, no tools, no questions.',
    `Message:\n${message.length > MESSAGE_CHARS ? `${message.slice(0, MESSAGE_CHARS)}…` : message}`,
  ].join('\n\n')
}

/** The title in a run's answer, or undefined when it gave none worth keeping. */
export function parseTitle(text: string): string | undefined {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean)
  const title = line
    ?.replace(/^(title:\s*)/i, '')
    .replace(/^["'`*#\s]+|["'`*\s]+$/g, '')
    .replace(/\.$/, '')
    .trim()
  if (!title || title.length > TITLE_CHARS) return undefined
  return title
}
