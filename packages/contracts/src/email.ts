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

export const EnableAgentAddress = z.object({
  name: MailName.optional(),
  /** Its address on one of the workspace's domains (riley@acme.com), rather than Brigade's. */
  address: z.string().trim().toLowerCase().email().optional(),
})

/** A mailbox's address: on one of the workspace's domains, or null for Brigade's own. */
export const SetMailboxAddress = z.object({
  address: z.string().trim().toLowerCase().email().nullable(),
})

/** How a domain's mail reaches Brigade. */
export const DOMAIN_RECEIVING = ['direct', 'forward'] as const
export type DomainReceiving = (typeof DOMAIN_RECEIVING)[number]

/** A domain of the workspace's own (acme.com, or a subdomain: team.acme.com). */
export const CreateDomain = z.object({
  name: z.string().trim().toLowerCase().min(3).max(253),
  /** Default: direct when its mail goes nowhere yet, forward when a provider (Google) has it. */
  receiving: z.enum(DOMAIN_RECEIVING).optional(),
})

/** Add a domain's records on Cloudflare with one of the workspace's Cloudflare accounts. */
export const AddDomainRecords = z.object({ connectionId: z.string().min(1) })

/** What Brigade sees of a domain before it is added: where its mail goes now. */
export type DomainLookup = {
  name: string
  /** Its MX hosts, best first; empty when its mail goes nowhere. */
  mx: string[]
  /** Brigade's own receiving already (its MX points to it). */
  brigade: boolean
  suggested: DomainReceiving
}

/** Who a domain's mail goes to now, by its MX. */
export type MailProvider = 'google' | 'microsoft' | 'other'

/**
 * How a mailbox's address on a domain receiving by forwarding gets its mail here: the provider
 * its mail is with, and Google's latest forwarding check mail, with its code, once one arrived.
 */
export type MailForwarding = { provider: MailProvider } & (
  | { found: false }
  | { found: true; at: string; subject: string; code: string | null; link: string | null }
)

/** Whether a domain's records can be added on Cloudflare, and with which of the workspace's accounts. */
export type CloudflareDnsSetup = {
  /** Its DNS is served by Cloudflare (its zone's nameservers). */
  onCloudflare: boolean
  /** The Cloudflare App accounts the member may use: shared ones, and their own. */
  accounts: { id: string; label: string }[]
}

/** One record Brigade tried to add on Cloudflare. */
export type CloudflareDnsResult = {
  type: string
  /** Its full name, e.g. resend._domainkey.acme.com. */
  name: string
  /** added; present (already there); conflict (another record holds its name: left alone); failed. */
  result: 'added' | 'present' | 'conflict' | 'failed'
  note?: string
}

/** A domain of the workspace, as Inbox › Mail settings › Domains shows it. */
export type MailDomainView = {
  id: string
  name: string
  /** Its DNS records as Resend last checked them: sending, and receiving when direct. */
  status: 'pending' | 'verified' | 'failed'
  receiving: DomainReceiving
  records: {
    record: string
    type: string
    name: string
    value: string
    priority?: number
    status: string
  }[]
  checkedAt: string | null
  /** The mailboxes' addresses on it. */
  addresses: string[]
}

export const CreateInbox = z.object({
  projectId: z.string(),
  /** What it is for, in its name and on its account: "Support". */
  label: z.string().trim().min(1).max(40),
  /** The name on what it sends. Default: the project's. */
  displayName: z.string().trim().min(1).max(80).optional(),
  /** The address customers write to (support@acme.com): checked first, the inbox made with it. */
  publicAddress: z.string().trim().email().optional(),
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
