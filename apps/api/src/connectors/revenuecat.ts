import type { ConnectorDefinition } from './types.js'

const read = (description: string) => ({ description, write: false })
const write = (description: string) => ({ description, write: true })

/**
 * RevenueCat's own MCP server: a project's apps, products and their store state (App Store
 * Connect, Google Play), entitlements, offerings and packages, paywalls, customers and their
 * subscriptions, in-app currencies, charts, metrics and experiments, webhooks and customer
 * sign-in (IAM).
 *
 * Signed in with a secret API v2 key the member pastes, sent as a Bearer token, as RevenueCat's
 * docs offer. Its OAuth is not open to Brigade: its registration endpoint answers only clients
 * RevenueCat registered itself (Claude, VS Code…), and refuses others with "The client is not
 * registered. Contact support". A v2 secret key belongs to one project, with the permissions
 * chosen as it was made (read only, or read and write per area), so the row shows that project.
 *
 * Tools from RevenueCat's Tools Reference, with its read and write marks, which the server's own
 * readOnlyHint marks agree with. The server lists a key only the tools its permissions reach: a
 * read-only project key got 114 of these, without billing, audiences or IAM. A tool the server
 * adds later and marks readOnlyHint is a read; any other unlisted tool is a write (types.ts).
 */
export const revenuecat: ConnectorDefinition = {
  kind: 'revenuecat',
  label: 'RevenueCat',
  auth: 'api_key',
  operations: {},
  mcp: {
    url: 'https://mcp.revenuecat.ai/mcp',
    auth: 'api_key',
    // No whoami: the key's project, which list-projects gives as its only one.
    account: { tool: 'list-projects', name: revenuecatAccountName },
    tools: {
      // Projects and apps
      'get-account-billing': read('The RevenueCat plan, billing period and tracked revenue.'),
      'list-account-billing-invoices': read('Invoices RevenueCat charged the account.'),
      'list-projects': read('List the projects the key reaches.'),
      'create-project': write('Create a project.'),
      'get-project-ui-config': read('A project’s paywall fonts, colors and presets.'),
      'update-project-ui-config': write('Change a project’s paywall fonts, colors and presets.'),
      'get-refund-request-preferences': read('A project’s Refund Control settings.'),
      'list-collaborators': read('People with access to the project, and their roles.'),
      'list-audit-logs': read('Changes made to the project’s configuration.'),
      'list-apps': read('List the apps of a project.'),
      'get-app': read('Read an app’s configuration.'),
      'create-app': write('Create an app in a project.'),
      'update-app': write('Change an app’s name or store details.'),
      'list-app-public-api-keys': read('An app’s public SDK keys.'),
      'list-app-subscription-groups': read('An app’s App Store subscription groups.'),
      'validate-app-credentials': read('Check an app’s saved store credentials.'),

      // Products and their store state
      'list-products': read('List the subscription and in-app purchase products.'),
      'get-product': read('Read a product.'),
      'create-product': write('Add a product to RevenueCat, not to the store.'),
      'update-product': write('Change a product.'),
      'archive-product': write('Archive a product in RevenueCat.'),
      'unarchive-product': write('Bring back an archived product.'),
      'get-product-store-state': read('A product’s live state in its store.'),
      'list-product-store-state-plans': read('List the plans of store changes.'),
      'get-product-store-state-plan': read('Read a plan of store changes.'),
      'create-product-store-state-plan': write('Draft a plan to create or change store products.'),
      'update-product-store-state-plan': write('Change a draft plan of store changes.'),
      'plan-product-store-state-plan': write('Work out what a draft plan changes in the store.'),
      'apply-product-store-state-plan': write('Apply a plan’s changes in the store.'),
      'discard-product-store-state-plan': write('Discard a plan of store changes.'),
      'create-product-store-state-review-screenshot': write(
        'Add an App Store review screenshot to a plan.',
      ),
      'submit-products-to-store': write('Submit App Store products for review.'),
      'get-product-store-state-operation': read('A store change’s progress (deprecated).'),
      'set-product-store-state': write('Change a product in its store (deprecated).'),
      'create-product-prices': write('Set a product’s store prices (deprecated).'),
      'equalize-subscription-prices': write('Even out prices across countries (deprecated).'),
      'upload-product-store-state-screenshot': write(
        'Upload a store review screenshot (deprecated).',
      ),

      // Entitlements
      'list-entitlements': read('List the entitlements of a project.'),
      'get-entitlement': read('Read an entitlement.'),
      'get-products-from-entitlement': read('The products that unlock an entitlement.'),
      'create-entitlement': write('Create an entitlement.'),
      'update-entitlement': write('Rename an entitlement.'),
      'archive-entitlement': write('Archive an entitlement.'),
      'unarchive-entitlement': write('Bring back an archived entitlement.'),
      'attach-products-to-entitlement': write('Make products unlock an entitlement.'),
      'detach-products-from-entitlement': write('Stop products unlocking an entitlement.'),

      // Offerings and packages
      'list-offerings': read('List the offerings of a project.'),
      'get-offering': read('Read an offering.'),
      'get-offering-prices': read('An offering’s prices by country and currency.'),
      'list-packages': read('List the packages of an offering.'),
      'create-offering': write('Create an offering.'),
      'update-offering': write('Change an offering.'),
      'duplicate-offering': write('Copy an offering and its packages.'),
      'archive-offering': write('Archive an offering: apps no longer get it.'),
      'unarchive-offering': write('Bring back an archived offering.'),
      'create-packages': write('Add a package to an offering.'),
      'delete-package-from-offering': write('Delete a package for good.'),
      'attach-products-to-package': write('Add products to a package.'),
      'detach-products-from-package': write('Remove products from a package.'),

      // Targeting and audiences
      'list-audiences': read('List the saved customer segments.'),
      'get-audience': read('Read an audience and its rules.'),
      'get-audience-filter-options': read('Known values for audience rules.'),
      'preview-audience': read('The customers rules would match, without saving them.'),
      'create-audience': write('Save a customer segment.'),
      'update-audience': write('Change an audience’s name or rules.'),
      'list-targeting-rules': read('List the targeting rules.'),
      'get-targeting-rule': read('Read a targeting rule.'),
      'create-targeting-rule': write('Create a targeting rule.'),
      'update-targeting-rule': write('Change a targeting rule.'),
      'delete-targeting-rule': write('Delete a targeting rule.'),

      // Paywalls
      'list-paywalls': read('List the paywalls of a project.'),
      'get-paywall': read('Read a paywall’s design.'),
      'render-paywall-screenshot': read('A screenshot of a paywall.'),
      'get-paywall-ai-task': read('The progress of an AI paywall task.'),
      'create-paywall-ai': write('Have AI make a new, unpublished paywall.'),
      'edit-paywall-ai': write('Have AI change a paywall.'),
      'duplicate-paywall': write('Copy a paywall as a new, unpublished one.'),
      'attach-offering-to-paywall': write('Show a paywall for an offering.'),
      'detach-offering-from-paywall': write('Stop showing a paywall for an offering.'),
      'publish-paywall': write('Publish a paywall’s draft to the apps.'),
      'unpublish-paywall': write('Take a paywall out of the apps.'),

      // Customers and subscriptions
      'list-customers': read('Find customers by email, app user ID or transaction ID.'),
      'get-customer': read('A customer’s attributes, entitlements and details.'),
      'list-customer-events': read('A customer’s event history.'),
      'list-subscriptions': read('A customer’s subscriptions, in every store.'),
      'get-subscription': read('Read a subscription.'),
      'list-purchases': read('A customer’s one-time purchases and refunds.'),
      'get-customer-center-config': read('A customer’s Customer Center settings.'),
      'assign-customer-offering': write('Choose which offering a customer’s app gets.'),
      'grant-customer-entitlement': write('Give a customer free access until a date.'),

      // In-app currencies
      'list-virtual-currencies': read('List the in-app currencies.'),
      'get-virtual-currency': read('Read an in-app currency.'),
      'list-virtual-currencies-balances': read('A customer’s in-app currency balances.'),
      'create-virtual-currency': write('Create an in-app currency.'),
      'update-virtual-currency': write('Change an in-app currency.'),
      'archive-virtual-currency': write('Archive an in-app currency.'),
      'unarchive-virtual-currency': write('Bring back an archived in-app currency.'),

      // Charts, metrics and experiments
      'get-overview-metrics': read('A project’s key metrics over the last 28 days.'),
      'get-revenue-metric': read('A project’s revenue over a date range.'),
      'get-chart-data': read('A chart’s data over time.'),
      'get-chart-options-schema': read('The options a chart takes.'),
      'get-benchmarks': read('How the project’s metrics compare with others.'),
      'list-chart-annotations': read('Notes on charts marking events.'),
      'create-chart-annotation': write('Add a note to charts.'),
      'update-chart-annotation': write('Change a chart note.'),
      'delete-chart-annotation': write('Delete a chart note.'),
      'list-experiments': read('List the experiments.'),
      'get-experiment': read('Read an experiment.'),
      'get-experiment-results': read('How each variant of an experiment performs.'),
      'create-experiment': write('Draft an experiment.'),
      'update-experiment': write('Change an experiment.'),
      'start-experiment': write('Start an experiment.'),
      'pause-experiment': write('Pause an experiment.'),
      'resume-experiment': write('Resume a paused experiment.'),
      'stop-experiment': write('Stop an experiment for good.'),

      // Webhooks
      'list-webhook-integrations': read('List the project’s webhooks.'),
      'get-webhook-integration': read('Read a webhook.'),
      'create-webhook-integration': write('Send the project’s events to a URL.'),
      'update-webhook-integration': write('Change a webhook.'),
      'delete-webhook-integration': write('Delete a webhook.'),

      // SDK
      'list-sdk-feature-gates': read('The SDK version each feature needs.'),
      'list-sdk-versions': read('The SDK versions the apps run.'),

      // Customer sign-in (IAM)
      'get-iam-settings': read('The project’s IAM migration mode.'),
      'update-iam-settings': write('Change the project’s IAM migration mode.'),
      'list-iam-authentication-methods': read('How customers sign in.'),
      'get-iam-authentication-method': read('Read a customer sign-in method.'),
      'create-iam-authentication-method': write('Add a way for customers to sign in.'),
      'update-iam-authentication-method': write('Change a customer sign-in method.'),
      'delete-iam-authentication-method': write('Remove a customer sign-in method.'),
    },
  },
}

/**
 * The key's project, as its row shows it: list-projects answers RevenueCat's API v2 list,
 * { object: 'list', items: [{ object: 'project', id, name, created_at, icon_url, ... }],
 * next_page, url }. A key
 * reaches one project; should it reach more, the first and how many others.
 */
export function revenuecatAccountName(output: unknown): string | null {
  const list = Array.isArray(output)
    ? output
    : ((output as { items?: unknown; projects?: unknown } | null)?.items ??
      (output as { projects?: unknown } | null)?.projects)
  if (!Array.isArray(list)) return null
  const names = list
    .map((p) => (p as { name?: unknown } | null)?.name)
    .filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
  if (!names.length) return null
  return names.length === 1 ? names[0]! : `${names[0]} +${names.length - 1}`
}
