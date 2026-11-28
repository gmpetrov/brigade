// The animation that installs an app (docs/apps.md, Installed apps), as Claude's does for an
// artifact: the app's pane in the dashboard lights up along its edge and folds into the app's
// icon, which waits there while Brigade makes the app; then the icon opens out into the app's own
// window, in a burst of light, and the window shows under it (page/install.html draws it).
//
// A transparent window over the display, above everything and taking no click, never focused:
// what the person was doing goes on under it. macOS and Windows; Linux desktops without a
// compositor draw a transparent window black, so there the window just opens.
import { join } from 'node:path'
import { BrowserWindow, screen, type Rectangle } from 'electron'

const supported = () => process.platform === 'darwin' || process.platform === 'win32'

/** The longest the icon waits for its window before the animation lets go. */
const WAIT_MS = 20_000

export type InstallAnimation = {
  /** The icon opens out to `to` (screen pixels); resolves when the window should show. */
  go: (to: Rectangle) => Promise<void>
  /** Stops it, fading: the install failed or was left. */
  cancel: () => void
}

const local = (r: Rectangle, origin: Rectangle) => ({
  x: r.x - origin.x,
  y: r.y - origin.y,
  width: r.width,
  height: r.height,
})

/**
 * Where an app's window opens on the display of `near`: 1100 × 760 at most, centered. The
 * animation opens out to the same place.
 */
export function appWindowBounds(near: Rectangle): Rectangle {
  const area = screen.getDisplayMatching(near).workArea
  const width = Math.min(1100, area.width - 80)
  const height = Math.min(760, area.height - 80)
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
  }
}

/** Starts the animation from `from` (the app's pane, on screen), with the app's icon. */
export function startInstallAnimation(from: Rectangle, iconPng: Buffer): InstallAnimation | null {
  if (!supported()) return null
  const display = screen.getDisplayMatching(from).bounds
  const overlay = new BrowserWindow({
    ...display,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    enableLargerThanScreen: true,
    roundedCorners: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  overlay.setIgnoreMouseEvents(true)
  overlay.setAlwaysOnTop(true, 'screen-saver')
  if (process.platform === 'darwin')
    overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  overlay.webContents.on('will-navigate', (event) => event.preventDefault())
  overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  const alive = () => !overlay.isDestroyed()
  const run = <T>(script: string) =>
    alive() ? (overlay.webContents.executeJavaScript(script, true) as Promise<T>) : Promise.reject()
  const close = () => alive() && overlay.destroy()
  const loaded = overlay
    .loadFile(join(__dirname, '..', 'page', 'install.html'))
    .then(() => {
      if (!alive()) return
      overlay.showInactive()
      const icon = `data:image/png;base64,${iconPng.toString('base64')}`
      return run(`install.start(${JSON.stringify({ from: local(from, display), icon })})`)
    })
    .catch(() => close())
  // Never left on screen: the window did not come, or something went wrong.
  const timer = setTimeout(() => cancel(), WAIT_MS)
  let going = false

  function cancel() {
    clearTimeout(timer)
    if (!alive()) return
    void run('install.cancel()').catch(() => {})
    setTimeout(close, 400)
  }

  return {
    async go(to) {
      if (going) return
      going = true
      clearTimeout(timer)
      try {
        await loaded
        await run(`install.go(${JSON.stringify({ to: local(to, display) })})`)
      } catch {
        close()
        return
      }
      // The light fades over the window, then goes.
      void run('install.done()')
        .catch(() => {})
        .finally(() => setTimeout(close, 50))
    },
    cancel,
  }
}
