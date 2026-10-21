# Billing

Brigade is free on members' own machines. **Brigade Cloud**, $99 a month per workspace
(€99 in the euro zone), adds the workspace's cloud computer. One subscription per
workspace, paid by the owner or admin who subscribes. All of it is in
`apps/api/src/billing.ts`.

## How it works

- **Billing is off without `STRIPE_SECRET_KEY`**: every workspace has the cloud computer
  when a provider is configured, as on a self-hosted Brigade.
- A workspace has the cloud computer while its plan (`BillingSubscription`) is `active`,
  `trialing` or `past_due` (Stripe still retrying a payment). Without it, no cloud
  computer is created and a stopped one does not start again. When a plan starts, the
  workspace's cloud computer is created; when it ends, the computer is stopped and keeps
  its disk until the plan comes back.
- Each workspace has its own Stripe customer (`Workspace.stripeCustomerId`), whoever pays:
  its portal shows only its own plan, and an admin who leaves takes nothing with them.
  Never a customer found by email: the Stripe account is shared with other products.
- **The rows only ever hold Stripe's current state**, read under a lock on the workspace
  (a Postgres advisory lock), never what an event says. Webhook events come late, twice,
  out of order or overlapping: each one only says "look again". The rows are written
  through the lock's own transaction, so a run that outlives its lock (a slow Stripe)
  writes nothing. When Stripe cannot be read, nothing changes and the webhook answers
  503, so Stripe sends the event again.
- **One payable Checkout per workspace**, under the same lock: the Checkouts still open
  are expired first, so none can be paid from then on; then a subscription Stripe has for
  the workspace (one paid just before, or paid with its webhook not here yet) becomes its
  plan and no Checkout is made; else a new Checkout is made. Should the lock have been
  lost meanwhile, that Checkout is expired before anyone sees its address.
- **The cloud computer follows the plan**, even when the provider is slow or fails:
  - a stop that fails answers the webhook 503, so Stripe sends it again;
  - each minute, every cloud computer that is up, being made or broken while its
    workspace has no plan is shut down (`enforcePlans`), until the provider does it;
  - the runner's hello stops a cloud computer whose workspace has no plan;
  - a computer still being made when the plan ends loses its VM once made: nothing was
    installed on it, and the next plan makes a new one;
  - a computer whose install never finished (no runner, nothing making it) is made again
    from a new VM rather than resumed;
  - a row that says "running" starts nothing without the plan.
- **An organization is not deleted while one of its workspaces has a subscription that is
  not over** (better-auth's `beforeDeleteOrganization`): it would go on billing a workspace
  that is gone. Once its deletion is decided, the organization is closed to Checkout
  (`Organization.billingClosingAt`, read under each workspace's lock) until it is gone, and
  its open Checkouts are expired; the closing lapses after 10 minutes should the deletion
  fail.
- Brigade's metadata on the Checkout and its subscription (`workspaceId`, `rowId`) tie
  them to the workspace. Events without it (another product's) are ignored.
- Settings › Billing (`/app/billing`) subscribes through Checkout and opens Stripe's
  customer portal (card, invoices, cancel at the end of the period). Onboarding offers
  it beside linking one's own machine. Back from Checkout (`/api/billing/return`), the
  plan is read from Stripe at once, without waiting for the webhook.
- The price is found by its lookup key `brigade_cloud_monthly`: one price, USD with a
  EUR currency option, so Checkout shows each customer their currency. Test and live
  accounts need no price ids in config.
- Add-ons later (an email address at $10 a month, say) are more items on the same
  subscription.
- better-auth's Stripe plugin was tried and left: it bills a user or an organization,
  not a workspace, and it saves each event's state as it comes, so a late event could
  bring back a canceled plan.

## Setting up an account

`pnpm --filter @brigade/api stripe:setup` with `STRIPE_SECRET_KEY` set makes, once:
the product `brigade_cloud`, its price `brigade_cloud_monthly`, and Brigade's own
customer portal settings (metadata `brigade=portal`, which the API uses rather than
the account's default). A live key needs `--live`. A preview whose `STRIPE_SECRET_KEY`
preview variable is a test key runs it on start.

The live account (Brigade, `acct_1TglYsRbMiIVQuK6`) is set up: product `brigade_cloud`,
price `price_1UT74MRbMiIVQuK6v1bZtWaf`, portal settings `bpc_1UT74aRbMiIVQuK6RnAaVTIF`.
The account also holds other products (Papers); their events reach the webhook and are
ignored.

## Production

On the `brigade-api` Worker (`wrangler secret put`):

- `STRIPE_SECRET_KEY`: a restricted live key with write on Customers, Checkout Sessions,
  Subscriptions and Customer portal, and read on Products and Prices.
- `STRIPE_WEBHOOK_SECRET`: the signing secret of the webhook to
  `https://api.brigade.lol/api/billing/webhook`, with the events
  `checkout.session.completed`, `customer.subscription.created`,
  `customer.subscription.updated` and `customer.subscription.deleted`.

Turning billing on takes the cloud computer from every workspace without a plan. Give a
workspace a complimentary plan first, by hand: a row with no Stripe subscription.

```sql
INSERT INTO "BillingSubscription" ("id", "workspaceId", "plan", "status", "updatedAt")
VALUES ('comp_' || '<workspace id>', '<workspace id>', 'cloud', 'active', now());
```

Settings › Billing shows it as "Included by Brigade", with nothing to manage.

## Previews

Without `STRIPE_WEBHOOK_SECRET`, the plan is read from Stripe when Checkout returns and
each time Settings › Billing opens, so a cancellation in the portal shows there.
