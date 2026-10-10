// Self-update. The API serves one runner bundle and names its SHA-256 when a
// runner connects. A runner installed from another bundle runs the API's own
// installer once no turn is running, then restarts into the new code. A runner
// started from source (no install stamp) never updates itself.
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { paths } from './config.js'

/** The installed runner: <install dir>/runner, holding dist/ and the installer's stamp. */
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const INSTALL_DIR = dirname(ROOT)

/** Exit code that tells the wrapper (bin/brigade-runner) to start the new runner. */
export const UPDATED_EXIT_CODE = 75
/** How often to look for a quiet moment while an update waits. */
const CHECK_EVERY_MS = 15_000
/** After a failed install, the same bundle is not tried again for this long. */
const RETRY_AFTER_MS = 60 * 60_000

/** SHA-256 of the bundle this runner was installed from; undefined when run from source. */
export function installedBundle(): string | undefined {
  try {
    return readFileSync(join(ROOT, '.bundle-sha256'), 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}

/** The last bundle that failed to install, kept across the restart that follows. */
const FAILED_FILE = join(paths.state, 'update-failed.json')

function failedAt(bundle: string) {
  try {
    const last = JSON.parse(readFileSync(FAILED_FILE, 'utf8')) as { bundle: string; at: number }
    return last.bundle === bundle ? last.at : 0
  } catch {
    return 0
  }
}

function recordFailure(bundle: string) {
  try {
    mkdirSync(paths.state, { recursive: true, mode: 0o700 })
    writeFileSync(FAILED_FILE, JSON.stringify({ bundle, at: Date.now() }), { mode: 0o600 })
  } catch (error) {
    console.warn(`could not record the failed update: ${String(error)}`)
  }
}

export class Updater {
  private target: string | undefined
  private timer: NodeJS.Timeout | undefined
  private installing = false
  private readonly installed = installedBundle()
  private readonly enabled = process.env.BRIGADE_AUTO_UPDATE !== '0'

  constructor(
    private readonly options: {
      apiUrl: string
      /** True when nothing would be cut short: no turn running, no terminal, no sign-in. */
      idle: () => boolean
      /** Disconnect and park every thread, keeping state for the new runner. */
      stop: () => Promise<void>
    },
  ) {}

  /**
   * The API serves `bundle`. Updates once idle; `now` (the API refuses this
   * runner's protocol) updates at once, since nothing can run meanwhile.
   */
  offer(bundle: string | undefined, now = false) {
    if (!bundle || !this.installed || bundle === this.installed) return false
    if (!this.enabled) {
      console.warn('A runner update is available (BRIGADE_AUTO_UPDATE=0, not installing it).')
      return false
    }
    if (Date.now() - failedAt(bundle) < RETRY_AFTER_MS) return false
    if (this.target !== bundle) {
      this.target = bundle
      console.log(
        `update available (${this.installed.slice(0, 12)} → ${bundle.slice(0, 12)}); installing when idle`,
      )
    }
    clearInterval(this.timer)
    if (now) void this.install()
    else this.timer = setInterval(() => this.options.idle() && void this.install(), CHECK_EVERY_MS)
    return true
  }

  private async install() {
    const bundle = this.target
    if (this.installing || !bundle) return
    this.installing = true
    clearInterval(this.timer)
    console.log('updating: saving thread state')
    await this.options.stop()
    const ok = await this.runInstaller()
    const now = installedBundle()
    if (!ok || now !== bundle) {
      // The installer swaps directories last: on failure the old runner is still in place.
      console.error(
        ok
          ? `update installed bundle ${now?.slice(0, 12)}, expected ${bundle.slice(0, 12)}`
          : 'update failed; restarting the current runner',
      )
      recordFailure(bundle)
    } else {
      console.log(`updated to ${bundle.slice(0, 12)}; restarting`)
    }
    this.restart()
  }

  /** The API's installer, into this runner's install directory. */
  private runInstaller() {
    return new Promise<boolean>((resolve) => {
      const child = spawn(
        'sh',
        ['-c', 'curl -fsSL "$1/runner/install.sh" | sh', 'sh', this.options.apiUrl],
        {
          cwd: INSTALL_DIR,
          env: { ...process.env, BRIGADE_INSTALL_DIR: INSTALL_DIR },
          stdio: 'inherit',
        },
      )
      child.on('error', () => resolve(false))
      child.on('close', (code) => resolve(code === 0))
    })
  }

  /**
   * Hand over to the new runner. The installer's wrapper and systemd both
   * restart on this exit. A runner started by an older wrapper (in a member's
   * terminal) runs the new one itself, once; the next start uses the new wrapper.
   */
  private restart(): never {
    if (process.env.BRIGADE_SUPERVISED || process.env.INVOCATION_ID) process.exit(UPDATED_EXIT_CODE)
    const result = spawnSync(join(INSTALL_DIR, 'bin', 'brigade-runner'), process.argv.slice(2), {
      stdio: 'inherit',
    })
    process.exit(result.status ?? 1)
  }
}
