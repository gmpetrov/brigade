// PostgreSQL's jsonb refuses some strings JSON allows: a NUL (\u0000) and a
// lone UTF-16 surrogate. A teammate's tool output can hold either (a log file
// with NUL padding, a binary file read as text), and one refused event stops a
// thread's events from being stored at all.
import { SequencedEvent, type AgentEvent } from '@brigade/contracts'

/** The value with every string made storable in jsonb: NULs dropped, lone surrogates replaced (U+FFFD). */
export function storableJson<T>(value: T): T {
  return clean(value) as T
}

function clean(value: unknown): unknown {
  if (typeof value === 'string') return cleanString(value)
  if (Array.isArray(value)) return value.map(clean)
  if (isPlain(value))
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [cleanString(key), clean(v)]))
  return value
}

function cleanString(text: string) {
  const wellFormed = text.isWellFormed() ? text : text.toWellFormed()
  return wellFormed.includes('\u0000') ? wellFormed.replaceAll('\u0000', '') : wellFormed
}

const isPlain = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype

/** Longest string an event's cut-short copy keeps. */
const CUT_AT = 2_000

/** What a thread shows where an event could not be stored at all. */
export const MISSING_EVENT = 'An update from this thread could not be saved, so it is missing here.'

/**
 * What to store of an event, best first: the event made storable, then the same with its
 * long strings cut short and a valid time, then only a note that it is missing. Each is
 * tried when the database refuses the one before, so an event is never left out: every
 * event after it would wait on it.
 */
export function storableForms(event: AgentEvent): AgentEvent[] {
  const at = Number.isNaN(Date.parse(event.at)) ? new Date().toISOString() : event.at
  const cleaned = storableJson(event)
  return [cleaned, { ...cut(cleaned), at }, missing(at, cleaned.teammateId)]
}

const missing = (at: string, teammateId?: unknown): AgentEvent => ({
  at,
  ...(typeof teammateId === 'string' ? { teammateId } : {}),
  type: 'raw',
  source: 'runner',
  value: MISSING_EVENT,
})

/**
 * The events of a runner's message the API could not read whole (one of another
 * version, say): those it cannot read become notes that they are missing, where
 * their thread and number say. Dropped, every later event of their thread would
 * wait on them. Undefined for a message that is not events.
 */
export function readableEvents(message: unknown): SequencedEvent[] | undefined {
  const raw = message as { type?: unknown; events?: unknown } | null
  if (raw?.type !== 'events' || !Array.isArray(raw.events)) return undefined
  return raw.events.flatMap((e: { sessionId?: unknown; seq?: unknown } | null) => {
    const read = SequencedEvent.safeParse(e)
    if (read.success) return [read.data]
    const { sessionId, seq } = e ?? {}
    return typeof sessionId === 'string' && Number.isInteger(seq) && (seq as number) > 0
      ? [{ sessionId, seq: seq as number, event: missing(new Date().toISOString()) }]
      : []
  })
}

function cut<T>(value: T): T {
  if (typeof value === 'string')
    return (value.length > CUT_AT ? `${value.slice(0, CUT_AT).toWellFormed()}… [cut]` : value) as T
  if (Array.isArray(value)) return value.map(cut) as T
  if (isPlain(value))
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, cut(v)])) as T
  return value
}
