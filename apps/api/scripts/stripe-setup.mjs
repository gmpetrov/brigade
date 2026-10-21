// What billing (src/billing.ts) needs in a Stripe account, made once, safe to run again:
// the Brigade Cloud product, its monthly price ($99, with €99 for euro customers) found by
// the lookup key brigade_cloud_monthly, and Brigade's own customer portal settings. With
// STRIPE_SECRET_KEY; a live key only with --live. `pnpm --filter @brigade/api stripe:setup`.
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

const PRODUCT = 'brigade_cloud'
const LOOKUP_KEY = 'brigade_cloud_monthly'

const product = await stripe.products.retrieve(PRODUCT).catch(async (error) => {
  if (error?.code !== 'resource_missing') throw error
  console.log(`Creating the product ${PRODUCT}`)
  return stripe.products.create({
    id: PRODUCT,
    name: 'Brigade Cloud',
    description:
      'Brigade’s cloud computer for one workspace: teammates keep working when your Mac is asleep, up to 4 threads at once.',
    metadata: { brigade_plan: 'cloud' },
  })
})

let [price] = (await stripe.prices.list({ lookup_keys: [LOOKUP_KEY], limit: 1 })).data
if (!price) {
  console.log(`Creating the price ${LOOKUP_KEY}`)
  price = await stripe.prices.create({
    product: product.id,
    currency: 'usd',
    unit_amount: 9900,
    currency_options: { eur: { unit_amount: 9900 } },
    recurring: { interval: 'month' },
    lookup_key: LOOKUP_KEY,
    nickname: 'Brigade Cloud monthly ($99 / €99)',
    metadata: { brigade_plan: 'cloud' },
  })
  await stripe.products.update(product.id, { default_price: price.id })
}

const portals = await stripe.billingPortal.configurations.list({ active: true, limit: 100 })
if (!portals.data.some((portal) => portal.metadata?.brigade === 'portal')) {
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
    },
    metadata: { brigade: 'portal' },
  })
}

console.log(`Stripe is ready for billing: ${price.id} (${LOOKUP_KEY})`)
