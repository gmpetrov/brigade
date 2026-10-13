// Live previews: an app a teammate runs in its thread (a dev server), which a
// person opens from the dashboard to try what the teammate built. The runner
// keeps the process; the API hands out the address people open it at.
import { z } from 'zod'
import { RepositoryName } from './repositories.js'

/** Runners from this protocol version on run previews. */
export const PREVIEW_PROTOCOL = 14
/** Runners from this version on start a saved preview for a person, without a turn (preview.start). */
export const PREVIEW_START_PROTOCOL = 17

/** Why a preview stopped when another took its place: said by its events, not shown in the thread. */
export const PREVIEW_REPLACED = 'Replaced by a new preview'

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

/**
 * The last check of a preview's pages (opened with Chrome as a person would):
 * running, or whether they passed and which did not.
 */
export const PreviewCheckState = z.object({
  status: z.enum(['checking', 'passed', 'failed']),
  /** Pages that failed. */
  failed: z.array(z.string().max(500)).max(10).optional(),
})
export type PreviewCheckState = z.infer<typeof PreviewCheckState>

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
  /** While it starts: running its setup (install, migrate, seed), or starting the app. */
  step: z.enum(['setup', 'app']).optional(),
  /** Its pages' last check; unset until one ran. Ready once it passed. */
  check: PreviewCheckState.optional(),
  /** owner/name of the checkout it runs from, and the commit checked out when it started. */
  repository: z.string().optional(),
  commit: z.string().optional(),
  /** When this run started, from runners that report checks (older ones say running when the port answers). */
  startedAt: z.string().optional(),
})
export type PreviewInfo = z.infer<typeof PreviewInfo>

/** Whether a preview is ready for people: it answers and its pages passed their check. */
export const previewReady = (p: Pick<PreviewInfo, 'status' | 'check' | 'startedAt'>) =>
  p.status === 'running' && (p.check?.status === 'passed' || !p.startedAt)

/**
 * What came of a person starting a thread's preview from the dashboard.
 * started: the runner starts it (again, or from its repository's saved
 * setup); running: it already runs. setup: nothing saved to start from, so
 * the teammate sets it up (the repositories checked out, if any). teammate:
 * it needs the teammate, e.g. to release its credentials from the vault.
 * waking: the workspace computer was stopped and starts first; ask again shortly.
 */
export const PreviewStartOutcome = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('started') }),
  z.object({ outcome: z.literal('running') }),
  z.object({ outcome: z.literal('waking') }),
  z.object({ outcome: z.literal('setup'), repositories: z.array(z.string()).max(20) }),
  z.object({ outcome: z.literal('teammate'), repository: z.string(), reason: z.string() }),
])
export type PreviewStartOutcome = z.infer<typeof PreviewStartOutcome>

/** A person starts a thread's preview: optionally of one repository it has checked out. */
export const StartPreview = z.object({
  repository: z.string().max(200).optional(),
})
export type StartPreview = z.infer<typeof StartPreview>

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
export const EnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'An environment variable name')

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

/**
 * A variable people give a repository's preview, beside its saved setup: a
 * setting (its value shown), a secret (written once, never shown again), or a
 * secret Brigade generated. Each start of the preview puts them in the app's
 * environment, over the setup's own settings; the teammate gets their names
 * only, and a secret's value is hidden in the preview's log.
 */
export const PreviewVariableKind = z.enum(['setting', 'secret', 'generated'])
export type PreviewVariableKind = z.infer<typeof PreviewVariableKind>

/** Set by the preview or the computer itself: no person sets these. */
const RESERVED_VARIABLES = new Set(['PORT', 'HOST', 'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL'])
export const reservedPreviewVariable = (name: string) =>
  RESERVED_VARIABLES.has(name) || name.startsWith('BRIGADE_')

export const PreviewVariableName = EnvName.max(100).refine(
  (name) => !reservedPreviewVariable(name),
  'The preview sets this variable itself',
)

export const PreviewVariable = z.object({
  name: z.string(),
  kind: PreviewVariableKind,
  /** A setting's value. Never a secret's. */
  value: z.string().optional(),
  /** What the app uses it for, as the teammate that asked for it said. */
  description: z.string().optional(),
  updatedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
  updatedAt: z.string(),
})
export type PreviewVariable = z.infer<typeof PreviewVariable>

const variableFields = {
  name: PreviewVariableName,
  description: z.string().trim().max(500).optional(),
}

/** A person sets some of a repository's preview variables: added, or replacing those of the same name. */
export const SetPreviewVariables = z.object({
  variables: z
    .array(
      z.discriminatedUnion('kind', [
        z.object({ ...variableFields, kind: z.literal('setting'), value: z.string().max(4000) }),
        z.object({
          ...variableFields,
          kind: z.literal('secret'),
          value: z.string().min(1).max(10_000),
        }),
        /** Brigade makes the value: a random one, for a session or signing secret. */
        z.object({ ...variableFields, kind: z.literal('generated') }),
      ]),
    )
    .min(1)
    .max(200),
})
export type SetPreviewVariables = z.infer<typeof SetPreviewVariables>

/**
 * A teammate reads or saves a repository's preview recipe. The runner also
 * reads its variables' values, for the app only, each time it starts it.
 */
export const PreviewOperation = z.discriminatedUnion('name', [
  z.object({ name: z.literal('get'), repository: RepositoryName }),
  z.object({ name: z.literal('save'), repository: RepositoryName, recipe: PreviewRecipe }),
  z.object({ name: z.literal('variables'), repository: RepositoryName }),
])
export type PreviewOperation = z.infer<typeof PreviewOperation>

/** A repository's preview, as the dashboard lists it: its saved setup, if any, and its variables. */
export const SavedPreview = z.object({
  repository: z.string(),
  /** Null while it has variables but no saved setup yet. */
  recipe: PreviewRecipe.nullable(),
  savedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
  savedFromSessionId: z.string().nullable(),
  updatedAt: z.string().nullable(),
  variables: z.array(PreviewVariable),
})
export type SavedPreview = z.infer<typeof SavedPreview>

/**
 * A thread's preview for a page other than the thread's (a pull request's),
 * or to check its events against: one they say runs, on a computer that is
 * offline or stopped, is stopped.
 */
export const ThreadPreviewState = z.object({
  preview: PreviewInfo.extend({ teammateId: z.string().optional() }).nullable(),
  teammateName: z.string(),
  computerName: z.string(),
  /** It runs on the workspace computer, not a member's own machine. */
  cloud: z.boolean(),
  mayControl: z.boolean(),
})
export type ThreadPreviewState = z.infer<typeof ThreadPreviewState>
