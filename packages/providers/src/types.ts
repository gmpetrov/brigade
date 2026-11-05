export type ComputerSize = '2x4' | '4x8' | '8x16'

export type ComputerSpec = {
  /** Used to name the machine; never sent to it as configuration. */
  workspaceId: string
  size: ComputerSize
}

/** Opaque to everything outside this package. Stored as JSON on Computer.providerRef. */
export type ComputerRef = { provider: string; id: string }

export type ComputerStatus = 'creating' | 'running' | 'stopped' | 'error' | 'destroyed'

/**
 * Whether a computer's disk is all there after a resume. `at` tells restores apart: the
 * same for the same restore.
 */
export type RestoreState = { done: false; running: boolean } | { done: true; at: string }

export type ExecResult = { exitCode: number; stdout: string; stderr: string }

/** A port of the computer on a public HTTPS address. */
export type HostedPort = {
  /** Where the port answers, with no secret in it: what the app is told it is served at. */
  origin: string
  /** What a person opens: the origin with whatever lets them in (a token). Never logged. */
  url: string
}

/**
 * The computer's desktop is still being set up after the provider's wait (desktopUrl): not a
 * failure, the caller asks again in a moment.
 */
export class DesktopNotReady extends Error {
  constructor(message = 'The desktop is still being prepared') {
    super(message)
    this.name = 'DesktopNotReady'
  }
}

/** Where an SSH key was let in: what to connect to, as whom, and the machine's own host key. */
export type SshAccess = { host: string; port: number; user: string; hostKey: string }

/**
 * Machines of their own for previews (docs/previews.md, the preview_machines feature): one per
 * thread, made when its preview first starts, stopped when nobody uses it, started again for its
 * next visit, destroyed with the thread. Nothing of Brigade's own goes in them.
 */
export interface MachineProvider {
  /** What one has, said to people: "8 vCPU, 16 GB". */
  readonly size: string
  /** Make one, running. The same `key` again gives the same machine: a retry makes no second one. */
  create(spec: { name: string; key: string }): Promise<ComputerRef>
  start(ref: ComputerRef): Promise<void> // resume with its disk
  stop(ref: ComputerRef): Promise<void> // keep the disk, stop billing
  destroy(ref: ComputerRef): Promise<void>
  status(ref: ComputerRef): Promise<ComputerStatus>
  /** Push back the provider's own stop, which only fires once nothing kept it alive. */
  keepAlive(ref: ComputerRef): Promise<void>
  /**
   * Let a public key in (it stays across stops) and say where to connect. Asked again after each
   * start: a started machine has a new address and a new host key.
   */
  authorize(ref: ComputerRef, publicKey: string): Promise<SshAccess>
}

export interface ComputerProvider {
  create(spec: ComputerSpec): Promise<ComputerRef>
  start(ref: ComputerRef): Promise<void> // resume with its disk
  stop(ref: ComputerRef): Promise<void> // keep the disk, stop billing
  keepAlive(ref: ComputerRef): Promise<void> // push back the provider's own auto-stop while in use
  destroy(ref: ComputerRef): Promise<void>
  exec(ref: ComputerRef, command: string): Promise<ExecResult> // install and start the runner
  /** The live desktop for takeover. Throws DesktopNotReady while it is still being set up. */
  desktopUrl(ref: ComputerRef): Promise<string | null>
  hostPort(ref: ComputerRef, port: number): Promise<HostedPort> // a stable public address for a port (previews)
  status(ref: ComputerRef): Promise<ComputerStatus>
  /**
   * For a provider that starts a computer before its disk is restored (boat copies the home
   * in from its snapshot in the background): whether that is done. `running` false: the
   * computer stopped, so it will not be.
   */
  restore?(ref: ComputerRef): Promise<RestoreState>
}
