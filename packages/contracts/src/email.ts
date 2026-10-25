// The Email App's dashboard API: Brigade's own addresses (an agent's, a project's inbox), their
// rules and their journal. See the API's src/mail/ and the spec agent-email-spec.md.
import { z } from 'zod'

/** The part of an address before the first dot: lowercase letters, digits and hyphens. */
export const MailName = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(30)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'Lowercase letters, digits and hyphens only')

export const EnableAgentAddress = z.object({ name: MailName.optional() })

export const CreateInbox = z.object({
  projectId: z.string(),
  /** What it is for, in its name and on its account: "Support". */
  label: z.string().trim().min(1).max(40),
  /** The name on what it sends. Default: the project's. */
  displayName: z.string().trim().min(1).max(80).optional(),
})

export const UpdateInbox = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  /** The address customers write to and replies go out from (support@lovarank.com); null to stop. */
  publicAddress: z.string().trim().email().nullable().optional(),
})

/** The address's rules in their new order: the first that matches a mail takes it. */
export const OrderRules = z.object({ triggerIds: z.array(z.string()).min(1).max(100) })

/** A rule's options tried on the address's latest mail, before it is made. */
export const PreviewRule = z.object({
  connectionId: z.string(),
  options: z.record(z.string(), z.string()).default({}),
  projectId: z.string().nullish(),
})

/** Where a received email went (MailMessage.route). */
export const MAIL_ROUTES = [
  'awaited',
  'conversation',
  'member',
  'rule',
  'box',
  'duplicate',
  'loop',
  'cap',
  'own_copy',
  'bounce',
  'test',
  'handed',
  'read',
] as const
export type MailRoute = (typeof MAIL_ROUTES)[number]

/** A journal line: an email and where it went, never its text. */
export type MailJournalEntry = {
  id: string
  direction: 'in' | 'out'
  status: string
  from: string
  to: string[]
  subject: string
  at: string
  route: MailRoute | null
  routeNote: string | null
  thread: { id: string; title: string } | null
  rule: { id: string; label: string } | null
  address: string
  sender: 'member' | 'contact' | 'unknown' | 'brigade' | null
}
