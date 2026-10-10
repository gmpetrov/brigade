import { z } from 'zod'

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
  RUNNER_BUNDLE_PATH: z
    .string()
    .default(new URL('../../runner/bundle/brigade-runner.tgz', import.meta.url).pathname),
  /** Master key for the vault (32 bytes, base64). Each organization's key is derived from it. */
  VAULT_KEY: z
    .string()
    .transform((v) => Buffer.from(v, 'base64'))
    .refine((b) => b.length === 32, 'VAULT_KEY must be 32 bytes, base64'),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
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
  BUCKET_DIR: z.string().default(new URL('../.bucket', import.meta.url).pathname),
})

export const env = Env.parse(process.env)

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
    cloud: { connectorWrites: 'ask', default: 'allow' },
    memberMachine: { writes: 'ask', commands: 'ask', connectorWrites: 'ask', default: 'allow' },
  },
  runnerLinkCodeMinutes: 10,
} as const
