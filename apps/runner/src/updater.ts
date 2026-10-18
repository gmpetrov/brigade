// Self-update. The API serves one runner bundle and names its SHA-256 when a
// runner connects. A runner installed from another bundle has the API's own
// installer download it beside itself while it works, then restarts into the
// new code at once: its running turns are handed over to the next runner, which
// takes them up where they are (hand-over.ts). It waits only for what a restart
// would cut short (a terminal, a sign-in), and not for long. A runner started
// from source (no install stamp) never updates itself.
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
/** Longest an update waits for a terminal or a sign-in to end: past that, they are closed. */
const WAIT_AT_MOST_MS = 30 * 60_000
/** After a failed install, the same bundle is not tried again for this long. */
const RETRY_AFTER_MS = 60 * 60_000

const stamp = (dir: string) => {
  try {
    return readFileSync(join(dir, '.bundle-sha256'), 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}

/** SHA-256 of the bundle this runner was installed from; undefined when run from source. */
export const installedBundle = () => stamp(ROOT)

/** SHA-256 of the bundle downloaded beside it, waiting to be put in place (the installer's stage). */
const stagedBundle = () => stamp(join(INSTALL_DIR, 'runner.new'))

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
  /** Since when `target` waits to be installed. */
  private since = 0
  /** The API refuses this runner: nothing waits. */
  private required = false
  private staged: string | undefined
  private staging = false
  private timer: NodeJS.Timeout | undefined
  private installing = false
  private readonly installed = installedBundle()
  private readonly enabled = process.env.BRIGADE_AUTO_UPDATE !== '0'

  constructor(
    private readonly options: {
      apiUrl: string
      /** Nothing a restart would cut short and cannot hand over: no terminal, no sign-in. */
      quiet: () => boolean
      /** Hand the running turns over and disconnect, keeping state for the new runner. */
      handOver: () => Promise<void>
    },
  ) {}

  /**
   * The API serves `bundle`: it is downloaded, then installed once quiet, or
   * at once when `now` (the API refuses this runner's protocol).
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
      this.since = Date.now()
      console.log(
        `update available (${this.installed.slice(0, 12)} → ${bundle.slice(0, 12)}); downloading it`,
      )
    }
    this.required ||= now
    void this.prepare()
    return true
  }

  /** Download the update beside this runner, which works on meanwhile; then install it when due. */
  private async prepare() {
    if (this.staging || this.installing) return
    if (this.staged !== this.target) {
      this.staging = true
      const bundle = this.target!
      const ok = await this.runInstaller('stage')
      this.staging = false
      // The API may serve another by now: what was downloaded is what gets installed. An
      // installer that cannot stage (an older API's) put it in place already.
      const swapped = installedBundle() !== this.installed ? installedBundle() : undefined
      const staged = ok ? (stagedBundle() ?? swapped) : undefined
      if (!staged) {
        console.error('could not download the update; trying again later')
        recordFailure(bundle)
        return
      }
      this.staged = staged
      if (staged === this.installed) return
    }
    clearInterval(this.timer)
    const due = () =>
      this.required || this.options.quiet() || Date.now() - this.since >= WAIT_AT_MOST_MS
    if (due()) return void this.install()
    console.log('update downloaded; installing once no terminal or sign-in is open')
    this.timer = setInterval(() => due() && void this.install(), CHECK_EVERY_MS)
  }

  private async install() {
    const bundle = this.staged
    if (this.installing || !bundle) return
    this.installing = true
    clearInterval(this.timer)
    console.log('updating: handing the running turns over')
    await this.options.handOver()
    const ok = installedBundle() === bundle || (await this.runInstaller('swap'))
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

  /** The API's installer, into this runner's install directory: its download, or putting it in place. */
  private runInstaller(step: 'stage' | 'swap') {
    return new Promise<boolean>((resolve) => {
      const child = spawn(
        'sh',
        ['-c', 'curl -fsSL "$1/runner/install.sh" | sh', 'sh', this.options.apiUrl],
        {
          cwd: INSTALL_DIR,
          env: { ...process.env, BRIGADE_INSTALL_DIR: INSTALL_DIR, BRIGADE_INSTALL_STEP: step },
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
