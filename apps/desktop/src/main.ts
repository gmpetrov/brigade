// Brigade.app: lives in the menu bar (the system tray on Windows and Linux). It installs, links
// and keeps running the Brigade runner (runner.ts), ships Brigade Computer Use.app for teammates
// to use this Mac's apps (helper.ts), serves computer use itself on Linux (linux/), starts at
// login and updates itself. Its windows are the
// dashboard (windows.ts), the new thread window (capture.ts) and the setup checklist (setup.ts).
import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { app } from 'electron'
import * as appWindows from './app-windows.js'
import * as autostart from './autostart.js'
import * as capture from './capture.js'
import { ctx } from './context.js'
import { Helper, linuxExecutable } from './helper.js'
import { LinuxComputerUse, serve } from './linux/computer-use.js'
import { INDICATOR_FLAG, runIndicator } from './linux/indicator.js'
import * as find from './find.js'
import { registerBridge } from './ipc.js'
import { APP_SHIM_FLAG, appArg } from './installed-apps.js'
import { handleQuit } from './lifecycle.js'
import { openLink } from './links.js'
import { createTray, keepAwake, refreshMenu, setAppMenu } from './menu.js'
import { runnerSupported, Supervisor } from './runner.js'
import { loadSettings, updateSettings } from './settings.js'
import * as setup from './setup.js'
import * as notifications from './notifications.js'
import { startUpdates } from './updates.js'
import { dashboardWindow, handleLinks, setUpSession, showDashboard } from './windows.js'

const SCHEME = 'brigade'

/** brigade:// links that came before the app was ready. */
const early: string[] = []
let ready = false
const link = (url: string) => (ready ? void openLink(url) : void early.push(url))
const linksIn = (argv: string[]) => argv.filter((arg) => arg.startsWith(`${SCHEME}://`))

/**
 * Linux: an AppImage has no desktop entry of its own, so brigade:// links would open nothing.
 * One is written for it, and made the links' handler. A .deb installs its own.
 */
function linuxLinks() {
  const appImage = process.env.APPIMAGE
  if (process.platform !== 'linux' || !appImage) return
  const dir = join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'applications')
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'brigade-desktop.desktop'),
      `[Desktop Entry]
Type=Application
Name=Brigade
Exec="${appImage.replace(/(["`$\\])/g, '\\$1')}" %U
Icon=brigade-desktop
Terminal=false
NoDisplay=true
MimeType=x-scheme-handler/${SCHEME};
`,
    )
    execFile(
      'xdg-mime',
      ['default', 'brigade-desktop.desktop', `x-scheme-handler/${SCHEME}`],
      () => {},
    )
  } catch {}
}

function start() {
  if (process.platform === 'win32') app.setAppUserModelId('ai.brigade.desktop')

  // Open at login, turned on once on the first launch; after that it is the person's choice.
  const settings = loadSettings()
  if (!settings.loginSet) {
    if (runnerSupported()) autostart.enable()
    updateSettings((s) => {
      s.loginSet = true
    })
  } else if (process.platform === 'win32' && !settings.loginSetWindowsRunner) {
    // Windows ran no teammates before, so Brigade did not open at login there: once, now that
    // it does, as on a first launch.
    autostart.enable()
  }
  if (process.platform === 'win32' && !settings.loginSetWindowsRunner)
    updateSettings((s) => {
      s.loginSetWindowsRunner = true
    })
  // An entry left on another copy (moved, renamed) follows this one, once it is installed.
  autostart.refresh(
    app.isPackaged && (process.platform !== 'darwin' || app.isInApplicationsFolder()),
  )

  const helper = new Helper(Helper.find(process.resourcesPath))
  helper.restart()
  ctx.helper = helper
  if (process.platform === 'linux') startLinuxComputerUse()
  ctx.quitting = false
  ctx.refreshMenu = refreshMenu
  ctx.supervisor = new Supervisor({
    ...(helper.app && { helper: helper.app }),
    onChange: () => refreshMenu(),
  })

  setUpSession()
  registerBridge()
  appWindows.registerAppsBridge()
  appWindows.startShimServer()
  find.registerFind()
  setup.registerSetup()
  handleLinks(link)
  setAppMenu()
  createTray()
  capture.applyShortcuts()
  if (settings.keepAwake) keepAwake(true)
  void ctx.supervisor.start()
  notifications.start()
  // Started for an installed app (its shim on macOS, its shortcut elsewhere): that app only.
  const forApp = appArg(process.argv)
  if (!forApp && !process.argv.includes(APP_SHIM_FLAG)) setup.showIfNeeded()
  linuxLinks()
  void appWindows.refreshInstalls()

  // The smoke test (test/e2e/smoke.mjs) reaches the app's parts from Playwright.
  if (process.env.BRIGADE_DESKTOP_TEST === '1')
    Object.assign(globalThis, {
      brigadeTest: { capture, setup, showDashboard, dashboardWindow, notifications, find, ctx },
    })

  ready = true
  for (const url of [...early, ...linksIn(process.argv)]) void openLink(url)
  early.length = 0
  if (forApp) void appWindows.openInstall(forApp)
  startUpdates()
}

/** Linux: Brigade.app answers the runner's computer use requests itself, on the socket Brigade
 * Computer Use.app listens on on a Mac. */
function startLinuxComputerUse() {
  try {
    const computer = new LinuxComputerUse()
    serve(computer, linuxExecutable())
    ctx.linux = computer
    app.on('will-quit', () => void computer.close())
  } catch (error) {
    console.error('computer use:', error)
  }
}

if (process.argv.includes(INDICATOR_FLAG)) {
  // The computer-use pill's own process (linux/indicator.ts): nothing else of the app.
  runIndicator()
} else if (!app.requestSingleInstanceLock()) {
  // A second launch (or a brigade:// link while running) goes to the first one.
  app.quit()
} else {
  handleQuit()
  if (process.defaultApp && process.argv[1])
    // `electron .` while developing: links come back to this app with its path.
    app.setAsDefaultProtocolClient(SCHEME, process.execPath, [resolve(process.argv[1])])
  else if (process.platform !== 'darwin') app.setAsDefaultProtocolClient(SCHEME)

  // macOS hands links over as events, from the first launch on.
  app.on('open-url', (event, url) => {
    event.preventDefault()
    link(url)
  })
  app.on('second-instance', (_event, argv) => {
    const links = linksIn(argv)
    const forApp = appArg(argv)
    if (links.length) links.forEach(link)
    // The runner starting Brigade for computer use (Linux): it runs already, nothing to show.
    else if (argv.includes('--computer-use')) return
    // An installed app's shortcut or launcher entry (Windows, Linux): its window.
    else if (forApp) {
      if (ready) void appWindows.openInstall(forApp)
    }
    // Opened again from Applications, the Start menu or a launcher: the dashboard.
    else if (ready) showDashboard()
  })
  // macOS: opened again while running (Finder, Spotlight, a click on its Dock icon).
  let launched = 0
  app.on('activate', () => {
    if (ready && Date.now() - launched > 3_000) showDashboard()
  })
  void app.whenReady().then(() => {
    launched = Date.now()
    // Started by an installed app's shim (macOS): no Dock icon of Brigade's own until one of
    // its windows opens.
    if (process.argv.includes(APP_SHIM_FLAG)) appWindows.startHidden()
    start()
  })
}
