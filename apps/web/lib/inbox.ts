// What the Inbox page decides without React, kept apart so it can be tested on its own.

/**
 * The live messages after which the list is asked again: a mail came or changed, a mailbox came
 * in or out of the Inbox, or a ticket opened or was decided (a reply to approve puts its
 * conversation in To do, and takes it out once decided).
 */
const LIST_EVENTS = new Set(['mail.updated', 'connections.updated', 'tickets.updated'])
export const reloadsInboxList = (type: string) => LIST_EVENTS.has(type)

/** An email a teammate asks to send, as far as approving it goes. */
export type DraftEmail = {
  to: string[]
  cc: string[]
  subject: string
  replying: boolean
  files: string[]
}

/**
 * Everything a person approves besides the words, one line each: whom it goes to (Cc too), its
 * subject (or that it answers in its conversation), and its files. Nothing is left out: a copy to
 * someone else or a file attached is what an approver most needs to see.
 */
export function draftFacts(draft: DraftEmail): [label: string, value: string][] {
  return [
    ['To', draft.to.join(', ')],
    ...(draft.cc.length ? [['Cc', draft.cc.join(', ')] as [string, string]] : []),
    [
      'Subject',
      draft.subject || (draft.replying ? 'Re: the conversation’s subject' : '(No subject)'),
    ],
    ...(draft.files.length ? [['Files', draft.files.join(', ')] as [string, string]] : []),
  ]
}

/** The filters the Inbox remembers between visits: its tab and pickers, not words or the open email. */
export const KEPT_FILTERS = ['status', 'source', 'teammate', 'project'] as const
export type KeptFilters = Partial<Record<(typeof KEPT_FILTERS)[number], string>>

/** Where a workspace's Inbox filters are kept, in this browser. */
export const filtersKey = (workspaceId: string) => `brigade.inbox.filters.${workspaceId}`

/** The filters of an Inbox address, to keep. */
export function keptFilters(params: URLSearchParams): KeptFilters {
  const kept: KeptFilters = {}
  for (const name of KEPT_FILTERS) {
    const value = params.get(name)
    if (value) kept[name] = value
  }
  return kept
}

/**
 * The filters to put back on arriving at the Inbox, or null: only when its address says nothing
 * (a link to a view or an email wins), and only what was kept as it should be.
 */
export function filtersToRestore(
  params: URLSearchParams,
  saved: string | null,
): KeptFilters | null {
  if ([...KEPT_FILTERS, 'q', 'item'].some((name) => params.has(name)) || !saved) return null
  let value: unknown
  try {
    value = JSON.parse(saved)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const kept: KeptFilters = {}
  for (const name of KEPT_FILTERS) {
    const v = (value as Record<string, unknown>)[name]
    if (typeof v === 'string' && v && v.length <= 200) kept[name] = v
  }
  return Object.keys(kept).length ? kept : null
}
