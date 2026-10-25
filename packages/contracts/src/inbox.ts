// The Inbox: every mail the workspace's mailboxes received, across agents, projects and sources
// (Brigade's own addresses, Gmail accounts), one row per conversation, with where it went. See
// the API's src/inbox.ts.
import { z } from 'zod'
import type { MailRoute } from './email.js'

/** waiting: nobody took it and no person marked it done. handled: a thread has it. */
export type InboxStatus = 'waiting' | 'handled' | 'done'

/**
 * What comes next in a conversation, shown on its row: a teammate's reply waiting for this
 * member's approval (an email_send ticket they may decide), or a reply set to leave later.
 */
export type InboxNext =
  | { kind: 'draft'; ticketId: string; teammate: { id: string; name: string } | null }
  | { kind: 'scheduled'; id: string; at: string }

/** A teammate's reply in the conversation, waiting for a person to approve it. */
export type InboxDraft = {
  ticketId: string
  teammate: { id: string; name: string } | null
  /** email_send's arguments: to, cc, subject, text, replyTo, sendAt… */
  input: Record<string, unknown>
  /** The thread's starter or an admin: the others see it, but cannot decide. */
  canDecide: boolean
  at: string
}

/** How far ahead an email can be set to leave (Resend schedules up to 30 days). */
export const SEND_LATER_MAX_DAYS = 30

/** A conversation, as its latest received mail shows it. */
export type InboxItem = {
  /**
   * mail:<MailMessage id> of its latest received mail, whatever its source: every source keeps
   * its mail there. Any of its mails' ids opens the conversation.
   */
  id: string
  source: { id: string; kind: 'email' | 'gmail' }
  /** The address it came to. */
  to: string
  from: string
  fromName: string
  subject: string
  snippet: string
  at: string
  status: InboxStatus
  /** Brigade's addresses: where it went. */
  route: MailRoute | null
  thread: { id: string; title: string } | null
  rule: { id: string; label: string } | null
  teammate: { id: string; name: string } | null
  project: { id: string; name: string } | null
  files: number
  sender: 'member' | 'contact' | 'unknown' | 'brigade' | null
  /** A sign-up's mail, which is its thread's: its subject and words are not shown. */
  hidden: boolean
  /** Its mails, received and sent. */
  count: number
  next: InboxNext | null
}

/** One mail of a conversation. */
export type InboxMessage = {
  id: string
  /** in: received; out: sent from Brigade's address (Gmail's sent mail is not kept). */
  direction: 'in' | 'out'
  from: string
  fromName: string
  to: string[]
  cc: string[]
  subject: string
  at: string
  /** Its own words; the earlier messages it quotes apart. */
  text: string
  quoted: string
  /** Its files: a received one opens at the API's /inbox/items/<its id>/files/<file id>. */
  attachments: { id: string; name: string; contentType: string; size: number }[]
  authentication: { spf?: string; dkim?: string; dmarc?: string } | null
  /** Sent mail: where it is. */
  sent: 'scheduled' | 'sent' | 'delivered' | 'bounced' | 'failed' | null
  /** Sent mail still to leave: when it does, and whether this member may cancel it. */
  sendAt: string | null
  canCancel: boolean
  hidden: boolean
}

/** A conversation, whole: its latest received mail in front, then each of its mails, oldest first. */
export type InboxDetail = InboxItem & {
  messages: InboxMessage[]
  routeNote: string | null
  /** Why nobody took it, in plain words, while it is unassigned. */
  reason: string | null
  /**
   * What a rule on its mailbox needs, for an owner or admin to add one from it: Brigade's mail
   * (its address, its project's variant; an agent's address: that agent). Null otherwise.
   */
  addRule: { connectionId: string; projectId: string | null; teammateId: string | null } | null
  /** The teammates it can be handed to: those given its mailbox. */
  handTo: { id: string; name: string }[]
  doneAt: string | null
  /** Its teammates' replies waiting for approval, oldest first. */
  drafts: InboxDraft[]
}

export type InboxSourceView = {
  id: string
  kind: 'email' | 'gmail'
  label: string
  address: string
  teammate: { id: string; name: string } | null
  project: { id: string; name: string } | null
}

export const InboxQuery = z.object({
  source: z.string().max(200).optional(),
  teammate: z.string().max(100).optional(),
  project: z.string().max(100).optional(),
  /**
   * waiting: to do (nobody took it, or a reply waits for this member's approval); handled: with
   * a teammate; scheduled: a reply set to leave later; done; all.
   */
  status: z.enum(['waiting', 'handled', 'scheduled', 'done', 'all']).optional(),
  q: z.string().max(200).optional(),
  /** The previous page's next. */
  before: z.string().max(200).optional(),
})

export const SetInboxDone = z.object({ done: z.boolean() })

export const HandInboxItem = z.object({
  teammateId: z.string(),
  /** What the person asks, before the mail. */
  note: z.string().max(5000).optional(),
  /** Its thread's project, for Gmail. Default: the item's; Brigade's mail stays in its mailbox's. */
  projectId: z.string().nullish(),
})
