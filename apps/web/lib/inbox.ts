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
