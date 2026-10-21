# Billing

Brigade is free on members' own machines. **Brigade Cloud**, $99 a month per workspace
(€99 in the euro zone), adds the workspace's cloud computer. One subscription per
workspace, paid by the owner or admin who subscribes.

## How it works

- better-auth's Stripe plugin (`@better-auth/stripe`, in `apps/api/src/auth.ts`) keeps
  `BillingSubscription` rows in step through Stripe's webhook and Checkout's return. A
  row's `referenceId` is the workspace.
- Each workspace has its own Stripe customer (`Workspace.stripeCustomerId`), whoever pays:
  its portal shows only its own plan, and an admin who leaves takes nothing with them.
  `startCheckout` in `apps/api/src/billing.ts` makes the Checkout for it, with the plugin's
  metadata, because the plugin would bill the member.
- One payable Checkout per workspace: under a lock on the workspace, the ones still open
  are expired before a new one is made, so a workspace cannot be subscribed twice.
- Webhooks can arrive late and out of order: after each subscription event, the plan is
  read again from Stripe, and Stripe's current state is what is kept.
- `apps/api/src/billing.ts` decides who has the cloud computer: a workspace whose plan
  is `active`, `trialing` or `past_due` (Stripe still retrying a payment). Without the
  plan, no cloud computer is created, and a stopped one does not start again.
- When a plan starts (webhook), the workspace's cloud computer is created; when it ends,
  the computer is stopped and keeps its disk until the plan comes back.
- Settings › Billing (`/app/billing`) subscribes through Checkout and opens Stripe's
  customer portal (card, invoices, cancel at the end of the period). Onboarding offers
  it beside linking one's own machine.
- **Billing is off without `STRIPE_SECRET_KEY`**: every workspace has the cloud computer
  when a provider is configured, as on a self-hosted Brigade.
- The price is found by its lookup key `brigade_cloud_monthly`: one price, USD with a
  EUR currency option, so Checkout shows each customer their currency. Test and live
  accounts need no price ids in config.
- Add-ons later (an email address at $10 a month, say) are more items on the same
  subscription (`lineItems` on the plan, or a subscription update).

## Setting up an account

`pnpm --filter @brigade/api stripe:setup` with `STRIPE_SECRET_KEY` set makes, once:
the product `brigade_cloud`, its price `brigade_cloud_monthly`, and Brigade's own
customer portal settings (metadata `brigade=portal`, which the API uses rather than
the account's default). A live key needs `--live`. A preview whose `STRIPE_SECRET_KEY`
preview variable is a test key runs it on start.

The live account (Brigade, `acct_1TglYsRbMiIVQuK6`) is set up: product `brigade_cloud`,
price `price_1UT74MRbMiIVQuK6v1bZtWaf`, portal settings `bpc_1UT74aRbMiIVQuK6RnAaVTIF`.
The account also holds other products (Papers): Brigade makes its own customers, one per
workspace, so their subscriptions never reach Brigade's rows; their events reach the
webhook and are ignored (the plugin logs an error for each).

## Production

On the `brigade-api` Worker (`wrangler secret put`):

- `STRIPE_SECRET_KEY`: a restricted live key with write on Customers, Checkout Sessions,
  Subscriptions and Customer portal, and read on Products and Prices.
- `STRIPE_WEBHOOK_SECRET`: the signing secret of the webhook to
  `https://api.brigade.lol/api/auth/stripe/webhook`, with the events
  `checkout.session.completed`, `customer.subscription.created`,
  `customer.subscription.updated` and `customer.subscription.deleted`.

Turning billing on takes the cloud computer from every workspace without a plan. Give a
workspace a complimentary plan first, by hand: a row with no Stripe subscription.

```sql
INSERT INTO "BillingSubscription" ("id", "plan", "referenceId", "status")
VALUES ('comp_' || '<workspace id>', 'cloud', '<workspace id>', 'active');
```

Settings › Billing shows it as "Included by Brigade", with nothing to manage.

## Previews

Without `STRIPE_WEBHOOK_SECRET`, the subscription is recorded when Checkout returns,
and Settings › Billing reads it from Stripe each time it opens, so a cancellation in
the portal shows there. A cloud computer is not created by itself then: Computers'
Create button does it.
