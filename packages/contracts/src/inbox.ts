// The Inbox: every mail the workspace's mailboxes received, across agents, projects and sources
// (Brigade's own addresses, Gmail accounts), with where each went. See the API's src/inbox.ts.
import { z } from 'zod'
import type { MailRoute } from './email.js'

/** waiting: nobody took it and no person marked it done. handled: a thread has it. */
export type InboxStatus = 'waiting' | 'handled' | 'done'

export type InboxItem = {
  /** email:<id> or gmail:<connection id>:<message id>. */
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
}

export type InboxDetail = InboxItem & {
  cc: string[]
  /** Its own words; the earlier messages it quotes apart. */
  text: string
  quoted: string
  authentication: { spf?: string; dkim?: string; dmarc?: string } | null
  attachments: { name: string; contentType: string; size: number }[]
  routeNote: string | null
  /** The teammates it can be handed to: those given its mailbox. */
  handTo: { id: string; name: string }[]
  doneAt: string | null
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
  status: z.enum(['waiting', 'handled', 'done', 'all']).optional(),
  q: z.string().max(200).optional(),
  before: z.string().datetime().optional(),
})

export const SetInboxDone = z.object({ done: z.boolean() })

export const HandInboxItem = z.object({
  teammateId: z.string(),
  /** What the person asks, before the mail. */
  note: z.string().max(5000).optional(),
  /** Its thread's project. Default: the item's. */
  projectId: z.string().nullish(),
})
