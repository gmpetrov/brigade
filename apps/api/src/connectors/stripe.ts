// Stripe connector (REST API), on a secret or restricted key kept in the vault.
import { z } from 'zod'
import { json, op, type ConnectorContext, type ConnectorDefinition } from './types.js'

const API = 'https://api.stripe.com/v1'
const VERSION = '2024-06-20'

type List<T> = { data: T[]; has_more: boolean }
type Customer = {
  id: string
  email: string | null
  name: string | null
  phone: string | null
  created: number
  delinquent?: boolean
  metadata?: Record<string, string>
  deleted?: boolean
}
type Charge = {
  id: string
  amount: number
  amount_refunded: number
  currency: string
  status: string
  paid: boolean
  refunded: boolean
  created: number
  description: string | null
  customer: string | null
  payment_intent: string | null
  receipt_url: string | null
}
type Invoice = {
  id: string
  number: string | null
  status: string | null
  amount_due: number
  amount_paid: number
  currency: string
  customer: string | null
  created: number
  due_date: number | null
  hosted_invoice_url: string | null
}
type Subscription = {
  id: string
  status: string
  customer: string
  cancel_at_period_end: boolean
  current_period_end?: number
  items?: {
    data: {
      price?: {
        id: string
        nickname: string | null
        unit_amount: number | null
        currency: string
        recurring?: { interval: string }
      }
    }[]
  }
}

const time = (seconds: number | null | undefined) =>
  seconds ? new Date(seconds * 1000).toISOString() : null

const customer = (c: Customer) => ({
  id: c.id,
  email: c.email,
  name: c.name,
  phone: c.phone,
  created: time(c.created),
  delinquent: c.delinquent,
  metadata: c.metadata,
})
const charge = (c: Charge) => ({
  id: c.id,
  amount: c.amount,
  amountRefunded: c.amount_refunded,
  currency: c.currency,
  status: c.status,
  refunded: c.refunded,
  created: time(c.created),
  description: c.description,
  customer: c.customer,
  paymentIntent: c.payment_intent,
  receipt: c.receipt_url,
})
const invoice = (i: Invoice) => ({
  id: i.id,
  number: i.number,
  status: i.status,
  amountDue: i.amount_due,
  amountPaid: i.amount_paid,
  currency: i.currency,
  customer: i.customer,
  created: time(i.created),
  due: time(i.due_date),
  url: i.hosted_invoice_url,
})
const subscription = (s: Subscription) => ({
  id: s.id,
  status: s.status,
  customer: s.customer,
  cancelAtPeriodEnd: s.cancel_at_period_end,
  currentPeriodEnd: time(s.current_period_end),
  prices: s.items?.data.map((item) => ({
    id: item.price?.id,
    nickname: item.price?.nickname,
    amount: item.price?.unit_amount,
    currency: item.price?.currency,
    interval: item.price?.recurring?.interval,
  })),
})

/** Stripe's form encoding, with nested keys like metadata[plan]=pro. */
function form(body: Record<string, unknown>, prefix = '', out = new URLSearchParams()) {
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue
    const name = prefix ? `${prefix}[${key}]` : key
    if (value !== null && typeof value === 'object')
      form(value as Record<string, unknown>, name, out)
    else out.append(name, value === null ? '' : String(value))
  }
  return out
}

const get = async <T>(ctx: ConnectorContext, path: string, query: Record<string, unknown> = {}) =>
  json<T>(
    await ctx.fetch(`${API}${path}?${form(query)}`, { headers: { 'stripe-version': VERSION } }),
  )

/** Writes carry the call's id as the idempotency key, so a retried call never acts twice. */
const post = async <T>(ctx: ConnectorContext, path: string, body: Record<string, unknown> = {}) =>
  json<T>(
    await ctx.fetch(`${API}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'stripe-version': VERSION,
        'idempotency-key': ctx.callId,
      },
      body: form(body),
    }),
  )

const id = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9]+$`), `A Stripe ${prefix}_ id`)
const limit = z.number().int().min(1).max(100).default(10)

export const stripe: ConnectorDefinition = {
  kind: 'stripe',
  label: 'Stripe',
  auth: 'api_key',
  operations: {
    stripe_search_customers: op({
      description:
        "Find customers by email or name. Uses Stripe's search syntax, e.g. email:'ada@example.com' or name~'Ada'.",
      write: false,
      input: z.object({ query: z.string().min(1).max(500), limit }),
      target: (i) => `customer search ${i.query}`,
      run: async (ctx, i) => {
        const list = await get<List<Customer>>(ctx, '/customers/search', i)
        return { customers: list.data.map(customer), hasMore: list.has_more }
      },
    }),
    stripe_get_customer: op({
      description: 'Read one customer.',
      write: false,
      input: z.object({ customerId: id('cus') }),
      target: (i) => `customer ${i.customerId}`,
      run: async (ctx, i) => customer(await get<Customer>(ctx, `/customers/${i.customerId}`)),
    }),
    stripe_list_charges: op({
      description: 'List recent charges (payments), newest first, optionally for one customer.',
      write: false,
      input: z.object({ customerId: id('cus').optional(), limit }),
      target: (i) => (i.customerId ? `charges of customer ${i.customerId}` : 'recent charges'),
      run: async (ctx, i) => {
        const list = await get<List<Charge>>(ctx, '/charges', {
          limit: i.limit,
          customer: i.customerId,
        })
        return { charges: list.data.map(charge), hasMore: list.has_more }
      },
    }),
    stripe_list_invoices: op({
      description: 'List invoices, newest first, optionally for one customer or status.',
      write: false,
      input: z.object({
        customerId: id('cus').optional(),
        status: z.enum(['draft', 'open', 'paid', 'uncollectible', 'void']).optional(),
        limit,
      }),
      target: (i) => (i.customerId ? `invoices of customer ${i.customerId}` : 'recent invoices'),
      run: async (ctx, i) => {
        const list = await get<List<Invoice>>(ctx, '/invoices', {
          limit: i.limit,
          customer: i.customerId,
          status: i.status,
        })
        return { invoices: list.data.map(invoice), hasMore: list.has_more }
      },
    }),
    stripe_list_subscriptions: op({
      description: 'List subscriptions, optionally for one customer or status.',
      write: false,
      input: z.object({
        customerId: id('cus').optional(),
        status: z
          .enum([
            'active',
            'past_due',
            'unpaid',
            'canceled',
            'incomplete',
            'trialing',
            'paused',
            'all',
          ])
          .default('all'),
        limit,
      }),
      target: (i) => (i.customerId ? `subscriptions of customer ${i.customerId}` : 'subscriptions'),
      run: async (ctx, i) => {
        const list = await get<List<Subscription>>(ctx, '/subscriptions', {
          limit: i.limit,
          customer: i.customerId,
          status: i.status,
        })
        return { subscriptions: list.data.map(subscription), hasMore: list.has_more }
      },
    }),
    stripe_refund: op({
      description:
        'Refund a charge or payment intent, in full or in part (amount in the smallest currency unit, e.g. cents).',
      write: true,
      input: z
        .object({
          chargeId: id('ch').optional(),
          paymentIntentId: id('pi').optional(),
          amount: z.number().int().positive().optional().describe('Omit for a full refund'),
          reason: z.enum(['duplicate', 'fraudulent', 'requested_by_customer']).optional(),
        })
        .refine(
          (i) => Boolean(i.chargeId) !== Boolean(i.paymentIntentId),
          'Give chargeId or paymentIntentId',
        ),
      target: (i) =>
        `refund ${i.amount === undefined ? 'in full' : `of ${i.amount}`} on ${i.chargeId ?? i.paymentIntentId}`,
      run: async (ctx, i) => {
        const refund = await post<{ id: string; status: string; amount: number; currency: string }>(
          ctx,
          '/refunds',
          {
            charge: i.chargeId,
            payment_intent: i.paymentIntentId,
            amount: i.amount,
            reason: i.reason,
          },
        )
        return {
          id: refund.id,
          status: refund.status,
          amount: refund.amount,
          currency: refund.currency,
        }
      },
    }),
    stripe_update_customer: op({
      description:
        "Change a customer's email, name, phone or metadata. Only the given fields change.",
      write: true,
      input: z.object({
        customerId: id('cus'),
        email: z.email().optional(),
        name: z.string().max(256).optional(),
        phone: z.string().max(40).optional(),
        metadata: z.record(z.string().max(40), z.string().max(500)).optional(),
      }),
      target: (i) => `customer ${i.customerId}`,
      run: async (ctx, { customerId, ...fields }) =>
        customer(await post<Customer>(ctx, `/customers/${customerId}`, fields)),
    }),
    stripe_cancel_subscription: op({
      description:
        'Cancel a subscription, at the end of the current period (default) or immediately.',
      write: true,
      input: z.object({
        subscriptionId: id('sub'),
        immediately: z.boolean().default(false),
      }),
      target: (i) =>
        `cancel subscription ${i.subscriptionId} ${i.immediately ? 'immediately' : 'at period end'}`,
      run: async (ctx, i) =>
        subscription(
          i.immediately
            ? await json<Subscription>(
                await ctx.fetch(`${API}/subscriptions/${i.subscriptionId}`, {
                  method: 'DELETE',
                  headers: { 'stripe-version': VERSION, 'idempotency-key': ctx.callId },
                }),
              )
            : await post<Subscription>(ctx, `/subscriptions/${i.subscriptionId}`, {
                cancel_at_period_end: true,
              }),
        ),
    }),
    stripe_send_invoice: op({
      description: 'Email an open invoice to its customer.',
      write: true,
      input: z.object({ invoiceId: id('in') }),
      target: (i) => `send invoice ${i.invoiceId}`,
      run: async (ctx, i) => invoice(await post<Invoice>(ctx, `/invoices/${i.invoiceId}/send`)),
    }),
  },
}

/** The account a key belongs to, to show which Stripe account a connection is. Never the key. */
export async function stripeAccount(apiKey: string) {
  const response = await fetch(`${API}/account`, {
    headers: { authorization: `Bearer ${apiKey}`, 'stripe-version': VERSION },
  })
  const mode = apiKey.includes('_test_') ? 'test mode' : 'live mode'
  // A restricted key may not read the account; it is still a working key.
  if (response.status === 403) return `Stripe (${mode})`
  const account = await json<{
    id: string
    email?: string | null
    business_profile?: { name?: string | null }
    settings?: { dashboard?: { display_name?: string | null } }
  }>(response)
  const name =
    account.settings?.dashboard?.display_name ?? account.business_profile?.name ?? account.email
  return `${name ? `${name} ` : ''}(${account.id}, ${mode})`
}
