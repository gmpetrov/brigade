// Triggers a teammate sets up from a thread (create_trigger): an App's event, or a custom
// app's URL, that starts a thread for it with standing instructions. Each waits for an
// owner's or admin's approval in a ticket, as one made on the Apps page is theirs alone:
// an outside event that starts work, on the accounts of the person who asked, is a door in.
import { z } from 'zod'

export const TriggerLabel = z.string().trim().min(1).max(80)
/** What the teammate does with each event: the first lines of each thread it starts. */
export const TriggerInstructions = z.string().trim().max(4000)

/** A teammate's trigger tools, sent as schedule.call operations and checked by the API. */
export const TriggerOperations = [
  /** The Apps whose events can start threads, with each one's events, and this teammate's triggers. */
  z.object({ name: z.literal('list_triggers') }),
  z.object({
    name: z.literal('create_trigger'),
    /** An App's account, from list_triggers. Or customApp. */
    connectionId: z.string().min(1).optional(),
    /** A new custom app, by its name (e.g. "Sentry"): added once approved, with the trigger's URL. */
    customApp: z.string().trim().min(1).max(80).optional(),
    /** The catalog id, e.g. payment_received; a custom app's is "received". */
    event: z.string().trim().min(1).max(80),
    options: z.record(z.string(), z.string().trim().max(500)).default({}),
    label: TriggerLabel,
    instructions: TriggerInstructions.min(1),
    /** Custom apps only: hmac when the sender can sign its body, none when it cannot. */
    verification: z.enum(['hmac', 'none']).optional(),
    /** Why, for the person who approves: what the member asked for. */
    reason: z.string().trim().max(1000).optional(),
  }),
] as const

const TRIGGER_OPERATIONS = new Set(['list_triggers', 'create_trigger'])

export const isTriggerOperation = <T extends { name: string }>(
  op: T,
): op is Extract<T, { name: 'list_triggers' | 'create_trigger' }> => TRIGGER_OPERATIONS.has(op.name)

/** A teammate's trigger, waiting in its approval ticket, as the dashboard reads it. */
export type TriggerProposalPayload = {
  triggerAction: 'create'
  teammateId: string
  /** The App's account it listens on; null for a custom app added once approved. */
  appConnectionId: string | null
  customApp?: string
  /** The App and account as people name it, e.g. "Stripe · acme" or "Custom app · Sentry". */
  app: string
  event: string
  /** The event as the catalog names it, e.g. "Payment received". */
  eventLabel: string
  options: Record<string, string>
  label: string
  instructions: string
  verification?: 'hmac' | 'none'
  reason?: string
  /** Set once approved: the trigger it made. */
  triggerId?: string
}
