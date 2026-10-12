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
