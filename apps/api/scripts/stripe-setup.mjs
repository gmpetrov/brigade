// What billing (src/billing.ts) needs in a Stripe account, made once, safe to run again: the
// Brigade Max product and its monthly price ($99, with €99 for euro customers) found by the
// lookup key brigade_cloud_monthly; the Brigade Starter product and its monthly price
// ($15 / €15, lookup key brigade_cloud_starter_monthly), each product named as people see the
// plan (renamed if it was made under another name); and Brigade's own customer portal
// settings, where a subscription moves between the two. With STRIPE_SECRET_KEY; a live key
// only with --live. `pnpm --filter @brigade/api stripe:setup`.
// The webhook is not made here: see STRIPE_WEBHOOK_SECRET in src/config.ts.
import Stripe from 'stripe'

const key = process.env.STRIPE_SECRET_KEY
if (!key) {
  console.error('STRIPE_SECRET_KEY is not set')
  process.exit(1)
}
if (/^(sk|rk)_live_/.test(key) && !process.argv.includes('--live')) {
  console.error('That is a live key: run with --live to set up the live account')
  process.exit(1)
}
const stripe = new Stripe(key)
const web = (process.env.WEB_URL ?? 'http://localhost:3000').split(',')[0].trim()

/** Each plan: its product, and its monthly price found by its lookup key. */
const PLANS = [
  {
    product: 'brigade_cloud',
    name: 'Brigade Max',
    description:
      'Brigade’s cloud computer for one workspace, with no limit of hours: teammates keep working when your computer is off.',
    tier: 'cloud',
    lookupKey: 'brigade_cloud_monthly',
    amount: 9900,
    nickname: 'Brigade Max monthly ($99 / €99)',
  },
  {
    product: 'brigade_cloud_starter',
    name: 'Brigade Starter',
    description:
      'Brigade’s cloud computer for one workspace, 100 hours a month: teammates keep working when your computer is off.',
    tier: 'starter',
    lookupKey: 'brigade_cloud_starter_monthly',
    amount: 1500,
    nickname: 'Brigade Starter monthly ($15 / €15)',
  },
]

const prices = []
for (const plan of PLANS) {
  const product = await stripe.products.retrieve(plan.product).catch(async (error) => {
    if (error?.code !== 'resource_missing') throw error
    console.log(`Creating the product ${plan.product}`)
    return stripe.products.create({
      id: plan.product,
      name: plan.name,
      description: plan.description,
      // Brigade's plan, and its tier (src/billing.ts PLANS).
      metadata: { brigade_plan: 'cloud', brigade_tier: plan.tier },
    })
  })
  let [price] = (await stripe.prices.list({ lookup_keys: [plan.lookupKey], limit: 1 })).data
  if (!price) {
    console.log(`Creating the price ${plan.lookupKey}`)
    price = await stripe.prices.create({
      product: product.id,
      currency: 'usd',
      unit_amount: plan.amount,
      currency_options: { eur: { unit_amount: plan.amount } },
      recurring: { interval: 'month' },
      lookup_key: plan.lookupKey,
      nickname: plan.nickname,
      metadata: { brigade_plan: 'cloud', brigade_tier: plan.tier },
    })
    await stripe.products.update(product.id, { default_price: price.id })
  }
  // Checkout and invoices show the product's name: the plan's, as people see it.
  if (product.name !== plan.name || product.description !== plan.description) {
    console.log(`Naming the product ${plan.product} ${plan.name}`)
    await stripe.products.update(product.id, { name: plan.name, description: plan.description })
  }
  prices.push({ product: product.id, price: price.id, lookupKey: plan.lookupKey })
}

// Moving between Starter and Max: the portal changes the subscription's price, charging the
// difference for the rest of the period at once (src/billing.ts startUpgrade).
const subscriptionUpdate = {
  enabled: true,
  default_allowed_updates: ['price'],
  proration_behavior: 'always_invoice',
  products: prices.map(({ product, price }) => ({ product, prices: [price] })),
}

const portals = await stripe.billingPortal.configurations.list({ active: true, limit: 100 })
const portal = portals.data.find((configuration) => configuration.metadata?.brigade === 'portal')
if (!portal) {
  console.log('Creating Brigade’s customer portal settings')
  await stripe.billingPortal.configurations.create({
    name: 'Brigade',
    business_profile: { headline: 'Manage your Brigade Cloud subscription' },
    default_return_url: `${web}/app/billing`,
    features: {
      customer_update: { enabled: true, allowed_updates: ['email', 'address', 'tax_id', 'name'] },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: { enabled: true, mode: 'at_period_end', proration_behavior: 'none' },
      subscription_update: subscriptionUpdate,
    },
    metadata: { brigade: 'portal' },
  })
} else {
  const has = new Set(portal.features.subscription_update?.products?.flatMap((p) => p.prices))
  if (
    !portal.features.subscription_update?.enabled ||
    prices.some(({ price }) => !has.has(price))
  ) {
    console.log('Letting Brigade’s customer portal move between Starter and Max')
    await stripe.billingPortal.configurations.update(portal.id, {
      features: { subscription_update: subscriptionUpdate },
    })
  }
}

console.log(
  `Stripe is ready for billing: ${prices.map((p) => `${p.price} (${p.lookupKey})`).join(', ')}`,
)
