/**
 * Dictation in the composers (GET /api/dictation): whether the microphone button records.
 * `plan`: it comes with Brigade Cloud, which the workspace has not; the button says so.
 * Unavailable without a Groq key on the API: no button at all.
 */
export type DictationStatus = { available: true } | { available: false; reason: 'plan' | 'off' }

/** What POST /api/dictation answers: the words heard, trimmed. */
export type DictationResult = { text: string }

/** The longest recording, in seconds, and the most bytes the API takes for one. */
export const DICTATION_MAX_SECONDS = 10 * 60
export const DICTATION_MAX_BYTES = 20 * 1024 * 1024
