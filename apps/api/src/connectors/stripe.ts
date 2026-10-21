// Stripe connector: Stripe's own MCP server, signed in with Stripe's OAuth. A sign-in may reach
// several Stripe accounts (a live account and its sandboxes), and each tool call names one
// (stripe_context) and its mode (livemode). A Brigade account is one Stripe account in one mode,
// as a key was: its sign-in reaches that one alone, and Brigade adds both to every call, so its
// access, triggers and grants never reach another account, even one added to the sign-in later.
import type { ConnectorDefinition } from './types.js'

const read = (description: string) => ({ description, write: false })
const write = (description: string) => ({ description, write: true })

/** A Stripe account a sign-in reaches, as list_available_accounts_or_orgs gives it. */
export type StripeAccount = { stripe_context: string; livemode: boolean; name?: string }

/** The accounts in list_available_accounts_or_orgs' output: { accounts: [...] }. */
export function stripeAccounts(output: unknown): StripeAccount[] {
  const list = (output as { accounts?: unknown } | null)?.accounts
  if (!Array.isArray(list)) return []
  return list.filter(
    (a): a is StripeAccount =>
      typeof a?.stripe_context === 'string' &&
      /^acct_\w+$/.test(a.stripe_context) &&
      typeof a.livemode === 'boolean',
  )
}

/**
 * A Stripe account as its row shows it: its name, id and mode, as accounts connected with a key
 * showed. The id and mode say which account the row is (stripeAccountOf).
 */
export const stripeAccountLabel = (a: StripeAccount) =>
  `${a.name ? `${a.name} ` : ''}(${a.stripe_context}, ${a.livemode ? 'live mode' : 'test mode'})`

/** The one account a sign-in reaches, as its row shows it; null when it reaches several. */
export function stripeAccountName(output: unknown): string | null {
  const accounts = stripeAccounts(output)
  return accounts.length === 1 ? stripeAccountLabel(accounts[0]!) : null
}

/** The Stripe account and mode a row is, from its label. */
export function stripeAccountOf(externalAccount: string | null) {
  const m = /\((acct_\w+), (live|test) mode\)$/.exec(externalAccount ?? '')
  return m ? { stripe_context: m[1]!, livemode: m[2] === 'live' } : null
}

/** A call's object for approvals and the log: the API operation, its parameters, the mode. */
function stripeTarget(tool: string, input: Record<string, unknown>) {
  const operation = input.stripe_api_operation_id
  if (typeof operation !== 'string') return null
  const parameters = JSON.stringify(input.parameters ?? {})
  const text = `${operation} ${parameters === '{}' ? '' : parameters}`.trim()
  const mode = input.livemode === false ? ' (test mode)' : ''
  return `${text.length > 280 ? `${text.slice(0, 280)}…` : text}${mode}`
}

/** Currencies Stripe counts in whole units. */
const ZERO_DECIMAL = new Set(
  'bif clp djf gnf jpy kmf krw mga pyg rwf ugx vnd vuv xaf xof xpf'.split(' '),
)
const money = (amount: number | null | undefined, currency: string | undefined) => {
  if (amount == null || !currency) return 'an unknown amount'
  const units = ZERO_DECIMAL.has(currency) ? amount : amount / 100
  return `${units.toFixed(ZERO_DECIMAL.has(currency) ? 0 : 2)} ${currency.toUpperCase()}`
}
// biome-ignore lint: event objects are untyped JSON
type Obj = any
const who = (o: Obj) =>
  o.receipt_email ?? o.customer_email ?? o.billing_details?.email ?? o.customer ?? 'no customer'
const lines = (...l: (string | false | null | undefined)[]) => l.filter(Boolean).join('\n')
const object = (event: { payload: Obj }) => event.payload.data?.object ?? {}
const livemode = (event: { payload: Obj }) => (event.payload.livemode ? '' : ' (test mode)')

export const stripe: ConnectorDefinition = {
  kind: 'stripe',
  label: 'Stripe',
  auth: 'mcp',
  triggers: {
    payment_received: {
      label: 'Payment received',
      description: 'A payment succeeds.',
      events: ['payment_intent.succeeded'],
      describe: (e) => {
        const o = object(e)
        return {
          title: `Payment received: ${money(o.amount_received ?? o.amount, o.currency)}${livemode(e)}`,
          summary: lines(
            `${money(o.amount_received ?? o.amount, o.currency)} from ${who(o)}${livemode(e)}.`,
            o.description && `Description: ${o.description}`,
            `Payment intent ${o.id}${o.invoice ? `, invoice ${o.invoice}` : ''}.`,
          ),
        }
      },
    },
    payment_failed: {
      label: 'Payment failed',
      description: 'A payment attempt fails, e.g. a declined card.',
      events: ['payment_intent.payment_failed'],
      describe: (e) => {
        const o = object(e)
        return {
          title: `Payment failed: ${money(o.amount, o.currency)}${livemode(e)}`,
          summary: lines(
            `${money(o.amount, o.currency)} from ${who(o)} failed${livemode(e)}.`,
            o.last_payment_error?.message && `Reason: ${o.last_payment_error.message}`,
            `Payment intent ${o.id}${o.invoice ? `, invoice ${o.invoice}` : ''}.`,
          ),
        }
      },
    },
    subscription_created: {
      label: 'New subscription',
      description: 'A customer subscribes.',
      events: ['customer.subscription.created'],
      describe: (e) => {
        const o = object(e)
        const price = o.items?.data?.[0]?.price
        return {
          title: `New subscription for ${o.customer}${livemode(e)}`,
          summary: lines(
            `Customer ${o.customer} subscribed${livemode(e)}, status ${o.status}.`,
            price &&
              `Plan: ${price.nickname ?? price.id}, ${money(price.unit_amount, price.currency)}${price.recurring ? ` per ${price.recurring.interval}` : ''}.`,
            `Subscription ${o.id}.`,
          ),
        }
      },
    },
    subscription_canceled: {
      label: 'Subscription canceled',
      description: 'A subscription ends.',
      events: ['customer.subscription.deleted'],
      describe: (e) => {
        const o = object(e)
        return {
          title: `Subscription canceled for ${o.customer}${livemode(e)}`,
          summary: lines(
            `Customer ${o.customer}'s subscription ended${livemode(e)}.`,
            o.cancellation_details?.reason && `Reason: ${o.cancellation_details.reason}`,
            o.cancellation_details?.feedback && `Feedback: ${o.cancellation_details.feedback}`,
            o.cancellation_details?.comment && `Comment: ${o.cancellation_details.comment}`,
            `Subscription ${o.id}.`,
          ),
        }
      },
    },
    dispute_opened: {
      label: 'Dispute opened',
      description: 'A customer disputes a charge with their bank.',
      events: ['charge.dispute.created'],
      describe: (e) => {
        const o = object(e)
        return {
          title: `Dispute opened: ${money(o.amount, o.currency)}${livemode(e)}`,
          summary: lines(
            `A dispute of ${money(o.amount, o.currency)} was opened${livemode(e)}, reason ${o.reason}.`,
            o.evidence_details?.due_by &&
              `Evidence due by ${new Date(o.evidence_details.due_by * 1000).toISOString()}.`,
            `Dispute ${o.id}, charge ${o.charge}.`,
          ),
        }
      },
    },
    refund_issued: {
      label: 'Refund issued',
      description: 'A charge is refunded, fully or in part.',
      events: ['charge.refunded'],
      describe: (e) => {
        const o = object(e)
        return {
          title: `Refund issued: ${money(o.amount_refunded, o.currency)}${livemode(e)}`,
          summary: lines(
            `${money(o.amount_refunded, o.currency)} of ${money(o.amount, o.currency)} refunded to ${who(o)}${livemode(e)}.`,
            `Charge ${o.id}${o.payment_intent ? `, payment intent ${o.payment_intent}` : ''}.`,
          ),
        }
      },
    },
  },
  operations: {},
  mcp: {
    url: 'https://mcp.stripe.com',
    account: { tool: 'list_available_accounts_or_orgs', name: stripeAccountName },
    target: stripeTarget,
    fixed: (connection) => stripeAccountOf(connection.externalAccount),
    // Which accounts the sign-in reaches is the person's choice on Stripe's page, not a teammate's.
    hidden: ['list_available_accounts_or_orgs', 'manage_stripe_accounts'],
    // As the server lists them to an OAuth sign-in. Its Treasury tools come only to accounts
    // with Treasury, and go by its read-only marks.
    tools: {
      stripe_api_search: read('Find the Stripe API operation for a task.'),
      stripe_api_details: read('The parameters of a Stripe API operation.'),
      stripe_api_read: read(
        'Read anything through the Stripe API: customers, payments, invoices, subscriptions, events…',
      ),
      stripe_api_write: write(
        'Create, change or cancel through the Stripe API: refunds, customers, invoices, subscriptions, products and prices…',
      ),
      stripe_analytics: read('Metrics and reports on payments, subscriptions and billing.'),
      search_stripe_documentation: read("Search Stripe's documentation."),
      stripe_implementation_planner: read(
        'Plan which Stripe products and integration a need takes.',
      ),
      atlas_company_formation: write('Start or resume forming a company with Stripe Atlas.'),
      send_stripe_feedback: write('Send feedback to Stripe.'),
    },
  },
}
