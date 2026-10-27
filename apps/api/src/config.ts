import { z } from 'zod'

/** A path next to this file's folder. Workers have no files (nor import.meta.url): unused there. */
const near = (path: string) => (import.meta.url ? new URL(path, import.meta.url).pathname : path)

const Env = z.object({
  PORT: z.coerce.number().default(3001),
  API_URL: z.url().default('http://localhost:3001'),
  /** Dashboard origins, comma-separated. The first is canonical. */
  WEB_URL: z
    .string()
    .default('http://localhost:3000')
    .transform((v) =>
      v
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    ),
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32),
  /** The runner bundle served at /runner/bundle.tgz (build with `pnpm --filter @brigade/runner bundle`). */
  RUNNER_BUNDLE_PATH: z.string().default(near('../../runner/bundle/brigade-runner.tgz')),
  /** Master key for the vault (32 bytes, base64). Each organization's key is derived from it. */
  VAULT_KEY: z
    .string()
    .transform((v) => Buffer.from(v, 'base64'))
    .refine((b) => b.length === 32, 'VAULT_KEY must be 32 bytes, base64'),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  /**
   * A second Google OAuth client, for Google's MCP servers (BigQuery and the rest), which
   * register no clients. Google wants agents on a client of their own: a web client with
   * "Use this client for an AI-powered agent" on and the redirect URI
   * {API_URL}/api/connections/oauth/mcp/callback.
   */
  GOOGLE_MCP_CLIENT_ID: z.string().optional(),
  GOOGLE_MCP_CLIENT_SECRET: z.string().optional(),
  /**
   * Gmail push, for "Email received" triggers: a Pub/Sub topic in the OAuth client's Google
   * Cloud project, e.g. projects/acme/topics/brigade-gmail, that
   * gmail-api-push@system.gserviceaccount.com may publish to, with a push subscription
   * to {API_URL}/events/gmail authenticated as GMAIL_PUBSUB_PUSH_ACCOUNT (audience: that
   * URL). Without them, Brigade checks inboxes every minute instead.
   */
  GMAIL_PUBSUB_TOPIC: z.string().optional(),
  /** The service account Pub/Sub signs its pushes as. */
  GMAIL_PUBSUB_PUSH_ACCOUNT: z.string().optional(),
  /**
   * Brigade's GitHub App, for GitHub connections. Setup URL
   * {API_URL}/api/connections/oauth/github/setup with "Redirect on update" on;
   * callback URL {API_URL}/api/connections/oauth/github/callback.
   */
  GITHUB_APP_ID: z.string().optional(),
  /** The app's URL name: github.com/apps/<slug>. */
  GITHUB_APP_SLUG: z.string().optional(),
  GITHUB_APP_CLIENT_ID: z.string().optional(),
  GITHUB_APP_CLIENT_SECRET: z.string().optional(),
  /** The app's private key: the .pem with \n escapes, or base64 of the file. */
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  /**
   * The app's webhook secret. Webhook URL {API_URL}/github/webhook, events "Push"
   * (and installation events, sent anyway): computers then fetch the pushed repository.
   */
  GITHUB_APP_WEBHOOK_SECRET: z.string().optional(),
  /** Minutes without activity before a cloud computer stops. */
  IDLE_STOP_MINUTES: z.coerce.number().positive().default(30),
  /** The one bucket (Cloudflare R2), for library files. */
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  /** Without R2 (development only): a local folder stands in for the bucket. */
  BUCKET_DIR: z.string().default(near('../.bucket')),
  /**
   * The collab server (apps/collab, a Cloudflare Worker) that syncs documents
   * people edit together. Without a secret, the dashboard edits documents
   * without live sync and saves them whole.
   */
  COLLAB_URL: z.url().default('http://localhost:8787'),
  /**
   * The sandbox origin designs are served from: a separate host (e.g.
   * https://designs.example.com) that points at this API, so a design's script
   * never runs where the dashboard's session is. designs.localhost in
   * development: browsers send it to this computer, as another site than localhost.
   */
  DESIGN_URL: z.preprocess((v) => v || undefined, z.url().optional()),
  /**
   * The previews' own site (apps/preview-gateway, a Cloudflare Worker), e.g.
   * https://brigade.surf: each preview at https://<id>.brigade.surf, which carries the
   * provider's token itself. Safari, and every browser on an iPhone, drops the provider's
   * token cookie in the dashboard's frame, so its previews stayed white there. Without
   * both, previews are at the provider's address.
   */
  PREVIEW_GATEWAY_URL: z.preprocess((v) => v || undefined, z.url().optional()),
  /**
   * Shared with the preview gateway (its SECRET): registers previews there, and signs the
   * access tokens that let people in.
   */
  PREVIEW_GATEWAY_SECRET: z.string().min(32).optional(),
  /** Shared with the collab server: signs editors' tokens and authenticates its calls. */
  COLLAB_SECRET: z.string().min(32).optional(),
  /**
   * The dashboard is shown in another site's frame (a preview in a thread):
   * session cookies are SameSite=None and partitioned, so the frame keeps them.
   */
  CROSS_SITE_COOKIES: z.stringbool().default(false),
  /**
   * Sign-up with a password. Off by default: members sign up with Google or a code mailed
   * to them (src/sign-in-code.ts), which proves they own the address; only accounts given a
   * password by hand (src/password-sign-in.ts) sign in with one. On locally and in previews
   * (.env.example), where the dev accounts have a password (prisma/seed.ts).
   */
  PASSWORD_SIGN_IN: z.stringbool().default(false),
  /**
   * Cloudflare Turnstile's secret key: a sign-in code is mailed only after the visitor
   * passed its check (the dashboard has the widget's site key, NEXT_PUBLIC_TURNSTILE_SITE_KEY).
   * Without it, no check.
   */
  TURNSTILE_SECRET_KEY: z.string().optional(),
  /**
   * Web push to the dashboard (src/notifications.ts): a P-256 key pair, base64url, from
   * `pnpm --filter @brigade/api vapid`. Without them, notifications are off.
   */
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  /** Who push services may contact about Brigade's pushes: mailto: or https:. Default: the dashboard's address. */
  VAPID_SUBJECT: z.string().optional(),
  /**
   * Billing (src/billing.ts): the Cloud plan, per workspace, gives it the cloud computer.
   * A Stripe secret key, restricted or not, of the account with the price whose lookup key
   * is brigade_cloud_monthly (scripts/stripe-setup.mjs). Without it, billing is off and every workspace has the cloud
   * computer (when a provider is configured), as on a self-hosted Brigade.
   */
  STRIPE_SECRET_KEY: z.string().optional(),
  /**
   * The signing secret of the Stripe webhook to {API_URL}/api/billing/webhook, with the
   * events checkout.session.completed and customer.subscription.created, .updated and .deleted.
   * Without it, a subscription is recorded when its Checkout returns, and Settings › Billing
   * reads it from Stripe each time it opens (a preview).
   */
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  /**
   * The Email App (src/mail/): agents' addresses on MAIL_DOMAIN, received and sent through
   * Resend. A Resend API key with full access, of the account where MAIL_DOMAIN is verified
   * for sending and receiving. Without it, the Email App is unavailable.
   */
  RESEND_API_KEY: z.string().optional(),
  /**
   * The signing secret (whsec_…) of the Resend webhook to {API_URL}/events/resend, with the
   * events email.received, email.sent, email.delivered, email.bounced and email.failed.
   */
  RESEND_WEBHOOK_SECRET: z.string().optional(),
  /** The domain agents' addresses are on. */
  MAIL_DOMAIN: z.string().default('mails.brigade.lol'),
  /**
   * Alerts to Brigade's operators (src/ops/, docs/monitoring.md): addresses, comma-separated,
   * mailed through Resend (RESEND_API_KEY) from alerts@MAIL_DOMAIN.
   */
  OPS_ALERT_EMAILS: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? '')
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean),
    ),
  /** A URL alerts are posted to as JSON: Slack's or Discord's incoming webhook, a Brigade custom app's. */
  OPS_ALERT_WEBHOOK_URL: z.url().optional(),
  /** Signs those posts (x-brigade-signature), for a receiver that checks them. */
  OPS_ALERT_WEBHOOK_SECRET: z.string().optional(),
  /** Bearer token for GET /health/ops, the alerts open now, for an uptime monitor outside. */
  OPS_TOKEN: z.string().min(24).optional(),
  /**
   * Cloudflare's analytics, for the Workers' failed invocations (exceptions, exceeded
   * limits): an API token with Account Analytics: Read, and the account's id.
   */
  CLOUDFLARE_API_TOKEN: z.string().optional(),
  CLOUDFLARE_ACCOUNT_ID: z.string().optional(),
})

// An empty value (KEY= in .env, as .env.example has them) means unset.
const parsed = Env.parse(
  Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== '')),
)
export const env = {
  ...parsed,
  DESIGN_URL: (
    parsed.DESIGN_URL ?? parsed.API_URL.replace(/\/\/localhost([:/]|$)/, '//designs.localhost$1')
  ).replace(/\/+$/, ''),
}

/**
 * Defaults chosen without the owner's confirmation (spec, "Defaults and
 * unverified assumptions"). Kept here so they are easy to change.
 */
export const defaults = {
  cloudComputerSize: '4x8',
  concurrentThreadsPerCloudComputer: 4,
  idleMinutesBeforeStop: 30,
  backupEvery: 'daily',
  permissionPolicy: {
    cloud: { connectorWrites: 'allow', default: 'allow' },
    memberMachine: {
      writes: 'allow',
      commands: 'allow',
      connectorWrites: 'allow',
      default: 'allow',
    },
  },
  runnerLinkCodeMinutes: 10,
} as const
