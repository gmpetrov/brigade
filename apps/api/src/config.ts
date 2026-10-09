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
  /** Minutes without activity before a cloud computer stops. */
  IDLE_STOP_MINUTES: z.coerce.number().positive().default(30),
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
