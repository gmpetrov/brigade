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
  /** Shared with the collab server: signs editors' tokens and authenticates its calls. */
  COLLAB_SECRET: z.string().min(32).optional(),
  /**
   * The dashboard is shown in another site's frame (a preview in a thread):
   * session cookies are SameSite=None and partitioned, so the frame keeps them.
   */
  CROSS_SITE_COOKIES: z.stringbool().default(false),
  /**
   * Web push to the dashboard (src/notifications.ts): a P-256 key pair, base64url, from
   * `pnpm --filter @brigade/api vapid`. Without them, notifications are off.
   */
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  /** Who push services may contact about Brigade's pushes: mailto: or https:. Default: the dashboard's address. */
  VAPID_SUBJECT: z.string().optional(),
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
