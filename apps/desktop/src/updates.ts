// Updates from GitHub Releases: electron-updater reads latest-mac.yml, latest.yml or
// latest-linux.yml of the latest release (app-update.yml, written by electron-builder, says
// where), downloads a newer Brigade.app and installs it on restart. Checked at launch and every
// six hours; from the menu, every outcome shows: the menu closes on the click, so the item's own
// text would go unseen. A newer version found then asks to restart now.
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import { ctx } from './context.js'
import { alert, confirm } from './dialogs.js'
import { stopForQuit } from './lifecycle.js'

const EVERY_MS = 6 * 60 * 60_000

type State = { phase: 'idle' } | { phase: 'downloading' | 'ready'; version: string }

let state: State = { phase: 'idle' }
let checking: Promise<void> | undefined

/** The menu's item for updates. */
export function menuItem() {
  switch (state.phase) {
    case 'idle':
      return { label: 'Check for updates…', enabled: true }
    // While it downloads, the item says so, and a second click can't start another.
    case 'downloading':
      return { label: `Downloading ${state.version}…`, enabled: false }
    case 'ready':
      return { label: `Restart to update to ${state.version}`, enabled: true }
  }
}

function set(next: State) {
  state = next
  ctx.refreshMenu()
}

/** The runner stops, then the new version starts in this one's place. */
export async function restartToUpdate() {
  if (await stopForQuit()) autoUpdater.quitAndInstall(false, true)
}

async function askRestart(version: string) {
  const restart = await confirm({
    title: 'Update ready',
    message: `Brigade ${version} is installed. Restart Brigade to use it, now or later from its menu.`,
    ok: 'Restart',
    cancel: 'Later',
  })
  if (restart) await restartToUpdate()
}

async function checkNow(manual: boolean) {
  if (state.phase === 'ready') {
    if (manual) await askRestart(state.version)
    return
  }
  if (!app.isPackaged) {
    if (manual) await alert('Updates', 'A development build of Brigade does not update itself.')
    return
  }
  let result: Awaited<ReturnType<typeof autoUpdater.checkForUpdates>>
  try {
    result = await autoUpdater.checkForUpdates()
  } catch (error) {
    if (manual) await alert('Could not check for updates', (error as Error).message, 'error')
    return
  }
  if (!result?.isUpdateAvailable || !result.downloadPromise) {
    if (manual) await alert('Brigade is up to date', `Version ${app.getVersion()}`)
    return
  }
  const version = result.updateInfo.version
  set({ phase: 'downloading', version })
  try {
    await result.downloadPromise
  } catch (error) {
    set({ phase: 'idle' })
    if (manual) await alert('Update failed', (error as Error).message, 'error')
    return
  }
  set({ phase: 'ready', version })
  if (manual) await askRestart(version)
}

/** One check at a time; a click during one waits for it, then shows its outcome. */
export function check(manual = false) {
  if (checking) {
    if (manual) void checking.then(() => checkNow(true))
    return
  }
  checking = checkNow(manual).finally(() => {
    checking = undefined
  })
}

export function startUpdates() {
  autoUpdater.autoDownload = true
  // A downloaded update also goes in when Brigade quits.
  autoUpdater.autoInstallOnAppQuit = true
  // Its blockmaps are fetched from the latest release whatever the version: whole files only.
  autoUpdater.disableDifferentialDownload = true
  autoUpdater.logger = null
  // Errors come back from each check; unhandled, the event would throw.
  autoUpdater.on('error', () => {})
  check()
  setInterval(() => check(), EVERY_MS).unref()
}
