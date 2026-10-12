// Live previews: an app a teammate runs in its thread (a dev server), which a
// person opens from the dashboard to try what the teammate built. The runner
// keeps the process; the API hands out the address people open it at.
import { z } from 'zod'

/** Runners from this protocol version on run previews. */
export const PREVIEW_PROTOCOL = 14

/** Ports a preview may listen on: unprivileged, and not the runner's own. */
export const PreviewPort = z.number().int().min(1024).max(65535)

/** Most ports one preview exposes: its app and a few services the browser calls (an API). */
export const PREVIEW_PORTS_MAX = 4

/** Lines of a preview's output the runner keeps, for the teammate and the dashboard. */
export const PREVIEW_LOG_LINES = 400

/**
 * starting: the command runs, its port does not answer yet. running: it answers.
 * failed: it exited or never answered. stopped: someone stopped it, or it expired.
 */
export const PreviewStatus = z.enum(['starting', 'running', 'failed', 'stopped'])
export type PreviewStatus = z.infer<typeof PreviewStatus>

/** What a preview is, as its events say. */
export const PreviewInfo = z.object({
  previewId: z.string(),
  status: PreviewStatus,
  command: z.string(),
  /** Where it runs, relative to the teammate's working directory ('' for the directory itself). */
  cwd: z.string(),
  /** The app's port: what a person opens. */
  port: PreviewPort,
  /** Other ports the app's pages call, e.g. its API, exposed too. */
  ports: z.array(PreviewPort).max(PREVIEW_PORTS_MAX - 1),
  /**
   * The port people's browsers reach: the runner's proxy in front of the app,
   * which serves the other ports under /__ports/<port>/. Unset from runners
   * before it, where people reach `port` itself.
   */
  publicPort: PreviewPort.optional(),
  /** Why it failed or stopped, for a person. */
  reason: z.string().optional(),
})
export type PreviewInfo = z.infer<typeof PreviewInfo>

/** A person's action on a thread's preview, from the dashboard. */
export const PreviewAction = z.enum(['restart', 'stop'])
export type PreviewAction = z.infer<typeof PreviewAction>

/** The address a person opens a preview at. */
export const PreviewView = z.object({
  /** Opens the app, signed in to it when the address needs a token. Never logged. */
  url: z.url(),
  /**
   * The app runs on a member's own machine: the address works only there.
   * Unset on the workspace computer, whose address works anywhere.
   */
  local: z.boolean().optional(),
})
export type PreviewView = z.infer<typeof PreviewView>

/** An environment variable's name. */
const EnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'An environment variable name')

/** owner/name of a GitHub repository. */
export const RepositoryName = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'A repository as owner/name')

/**
 * How a repository's preview starts, saved by a teammate once it passed its
 * check, so a later thread starts it in one step: start_preview's input, with
 * the working directory relative to the repository's root.
 */
export const PreviewRecipe = z.object({
  /** Run before `command` on each start, in `cwd`, stopping at the first failure: install, migrate, seed. */
  setup: z.string().max(4000).optional(),
  command: z.string().trim().min(1).max(2000),
  /** Relative to the repository's root; '' for the root. */
  cwd: z.string().max(500).default(''),
  port: PreviewPort,
  ports: z
    .array(PreviewPort)
    .max(PREVIEW_PORTS_MAX - 1)
    .default([]),
  /**
   * Settings for setup and command, not secrets. ${BRIGADE_PREVIEW_URL} and
   * ${BRIGADE_PREVIEW_URL_<port>} in a value become the preview's addresses.
   */
  env: z.record(EnvName, z.string().max(4000)).default({}),
  /** Also write `env` to this file, relative to `cwd`, for apps that read only their env file. */
  envFile: z.string().max(200).optional(),
  /** Vault credentials whose variables the app gets (its API keys, a database), by id. */
  credentials: z.array(z.string().min(1).max(64)).max(10).default([]),
  /** Pages the check opens, e.g. ["/", "/signin"]. */
  paths: z.array(z.string().startsWith('/').max(500)).min(1).max(10).default(['/']),
  timeoutSeconds: z.number().int().min(10).max(600).optional(),
})
export type PreviewRecipe = z.infer<typeof PreviewRecipe>

/** A teammate reads or saves a repository's preview recipe. */
export const PreviewOperation = z.discriminatedUnion('name', [
  z.object({ name: z.literal('get'), repository: RepositoryName }),
  z.object({ name: z.literal('save'), repository: RepositoryName, recipe: PreviewRecipe }),
])
export type PreviewOperation = z.infer<typeof PreviewOperation>
