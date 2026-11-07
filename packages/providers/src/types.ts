export type ComputerSize = '2x4' | '4x8' | '8x16'

export type ComputerSpec = {
  /** Used to name the machine; never sent to it as configuration. */
  workspaceId: string
  size: ComputerSize
  /**
   * Called as soon as the provider has the VM, before it waits for it to be up: from then on it
   * bills, so its running time is counted from here (docs/vm-costs.md).
   */
  onCreated?: (ref: ComputerRef) => Promise<void> | void
}

/**
 * What a start did: `resumedAt`, when the provider started the VM (it bills from then); null
 * when it was up already, or on its way up, so nothing was started.
 */
export type StartResult = { resumedAt: Date | null }

/** Opaque to everything outside this package. Stored as JSON on Computer.providerRef. */
export type ComputerRef = { provider: string; id: string }

export type ComputerStatus = 'creating' | 'running' | 'stopped' | 'error' | 'destroyed'

/**
 * Whether a computer's disk is all there after a resume. `at` tells restores apart: the
 * same for the same restore.
 */
export type RestoreState = { done: false; running: boolean } | { done: true; at: string }

export type ExecResult = { exitCode: number; stdout: string; stderr: string }

/**
 * What the provider knows of a computer's disk and machine (boat's): when it last saved the disk
 * or confirmed it had nothing new to save (`savedAt`), its last completed snapshot (`snapshotAt`,
 * what a forced stop keeps), and the machine's health as the provider sees it.
 */
export type SavedState = {
  savedAt: Date | null
  snapshotAt: Date | null
  health: string | null
  healthReason: string | null
}

/**
 * What the provider answered when asked to recover a computer that stopped answering:
 * `recovering`, it power-cycles its machine (or did, minutes ago); `reachable`, it reaches the
 * machine, so there is nothing to recover; `impossible`, it cannot power-cycle this machine (or
 * its power-cycle failed): what is left is a forced stop, then a start.
 */
export type RecoverAnswer = 'recovering' | 'reachable' | 'impossible'

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
  create(spec: {
    name: string
    key: string
    onCreated?: ComputerSpec['onCreated']
  }): Promise<ComputerRef>
  start(ref: ComputerRef): Promise<StartResult | void> // resume with its disk
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
  start(ref: ComputerRef): Promise<StartResult | void> // resume with its disk
  /**
   * Keep the disk, stop billing. `force`: stop even when the disk cannot be saved any more,
   * keeping its last completed snapshot (what was written since is lost); without it, boat refuses
   * to stop a computer it cannot save, and leaves it running.
   */
  stop(ref: ComputerRef, options?: { force?: boolean }): Promise<void>
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
  /** When the provider last saved the computer's disk, and how its machine is (SavedState). */
  saved?(ref: ComputerRef): Promise<SavedState>
  /** Ask the provider to bring back a computer that stopped answering (RecoverAnswer). */
  recover?(ref: ComputerRef): Promise<RecoverAnswer>
}

/** Where a VM is now, as the provider's list says: `running` bills, `stopped` does not. */
export type VmState = 'starting' | 'running' | 'stopped' | 'error'

/**
 * What the provider counts of a VM over a window: the seconds it ran (its own clock, not scaled
 * by size), what they cost at list price, and whether it runs at the window's end.
 */
export type VmUsage = { runSeconds: number; dollars: number; running: boolean }

/**
 * The provider's own figures, to keep Brigade's count of VM time right (docs/vm-costs.md): every
 * VM of the account and where it is, and what one ran over a window.
 */
export interface ProviderLedger {
  /** Every VM the account has (by its id), with its state; a VM not listed is gone. */
  states(): Promise<Map<string, VmState>>
  /** What a VM ran between `since` and `until`. Throws on a VM the provider no longer has. */
  usage(id: string, since: Date, until: Date): Promise<VmUsage>
  /** The account's plan and wallet, as the provider gives them, for operators. */
  limits(): Promise<unknown>
}
