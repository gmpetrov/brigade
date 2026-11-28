// The menu-bar menu (the tray: the system tray on Windows and Linux), built again whenever what
// it shows changes, and the app menu, live while one of Brigade's windows is in front.
import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  powerSaveBlocker,
  shell,
  Tray,
  webContents,
  type MenuItemConstructorOptions,
} from 'electron'
import * as appWindows from './app-windows.js'
import * as autostart from './autostart.js'
import * as capture from './capture.js'
import { ctx } from './context.js'
import { confirm } from './dialogs.js'
import { findAgain, openFind } from './find.js'
import { showLogs } from './logs.js'
import { label, runnerSupported } from './runner.js'
import * as installedApps from './installed-apps.js'
import { dashboard, loadSettings, updateSettings } from './settings.js'
import * as setup from './setup.js'
import * as shortcuts from './shortcuts.js'
import * as updates from './updates.js'
import { dashboardContents, dashboardWindow, showDashboard } from './windows.js'
import * as workspaces from './workspaces.js'

const assets = join(__dirname, '..', 'assets')

let tray: Tray | undefined

/** Keep screen awake: the display, and so the computer, stay awake for teammates to see and
 * use it, while Brigade runs. */
let awake: number | undefined

export function keepAwake(on: boolean) {
  if (awake !== undefined) powerSaveBlocker.stop(awake)
  awake = on ? powerSaveBlocker.start('prevent-display-sleep') : undefined
}

/** From the Workspace submenu: after a yes, the runner runs for that workspace instead. */
async function switchWorkspace(key: string) {
  const linked = workspaces.all()
  const active = workspaces.active()
  const target = linked.find((w) => w.key === key)
  // A click checks or unchecks the item itself: the menu shows the running one again.
  refreshMenu()
  if (!target || key === active) return
  const current = linked.find((w) => w.key === active)?.name
  const here = process.platform === 'darwin' ? 'This Mac' : 'This computer'
  const confirmed = await confirm({
    title: `Switch to ${target.name}?`,
    message: current
      ? `${here} will run ${target.name}'s teammates instead of ${current}'s. Work ${current}'s teammates were doing here is saved and carries on when you switch back.`
      : `${here} will run ${target.name}'s teammates.`,
    ok: 'Switch',
  })
  if (confirmed) await ctx.supervisor.switch(target.key)
}

function workspaceMenu(): MenuItemConstructorOptions {
  const linked = workspaces.all()
  const active = workspaces.active()
  const running = linked.find((w) => w.key === active)
  const items: MenuItemConstructorOptions[] = linked.map((w) => ({
    label: w.name,
    type: 'checkbox',
    checked: w.key === active,
    click: () => void switchWorkspace(w.key),
  }))
  if (items.length) items.push({ type: 'separator' })
  items.push({
    label: linked.length ? 'Add a workspace…' : 'Connect this computer…',
    click: () => void shell.openExternal(`${dashboard()}/computers?desktop=1`),
  })
  return {
    label: running ? `Workspace: ${running.name}` : 'Workspace: not connected',
    submenu: items,
  }
}

/** The Shortcuts submenu, a section for each shortcut: the chosen one checked once registered. */
function shortcutsMenu(): MenuItemConstructorOptions {
  const settings = loadSettings()
  const items: MenuItemConstructorOptions[] = []
  for (const kind of shortcuts.kinds()) {
    if (items.length) items.push({ type: 'separator' })
    items.push({ label: shortcuts.title(kind), enabled: false })
    const value = shortcuts.chosen(kind, settings)
    const working = value === 'off' || capture.registered[kind] === value
    for (const choice of shortcuts.choices(kind))
      items.push({
        label: choice.label,
        type: 'checkbox',
        checked: working && choice.id === value,
        click: () => capture.chooseShortcut(kind, choice.id),
      })
  }
  return { label: 'Shortcuts', submenu: items }
}

/** A shortcut's action, shown with its keys while they are registered. */
function action(
  kind: shortcuts.Kind,
  click: () => void,
  label = shortcuts.actionLabel(kind),
): MenuItemConstructorOptions {
  const keys = capture.registered[kind]
  return {
    label,
    click,
    ...(keys && { accelerator: shortcuts.accelerator(keys), registerAccelerator: false }),
  }
}

/**
 * What both menus show: the menu-bar menu (the tray) and, on macOS, the app menu while a
 * Brigade window is in front. Built from the same state each time, so they never disagree.
 * The tray writes its labels in sentence case, the app menu in macOS's title case.
 */
function items() {
  const runs = runnerSupported()
  const settings = loadSettings()
  const update = updates.menuItem()
  const screenshot = shortcuts.kinds().includes('screenshot')
  return {
    runs,
    status: { label: label(ctx.supervisor.status), enabled: false },
    workspace: workspaceMenu(),
    newThread: (title?: string) => action('newThread', () => capture.show(), title),
    screenshot: (title?: string) =>
      screenshot ? [action('screenshot', () => void capture.take(), title)] : [],
    openDashboard: (title = 'Open dashboard') => ({ label: title, click: () => showDashboard() }),
    openInBrowser: (title = 'Open in browser') => ({
      label: title,
      click: () => void shell.openExternal(dashboard()),
    }),
    setUp: (title = 'Set up Brigade…'): MenuItemConstructorOptions[] =>
      setup.hasSetup() ? [{ label: title, click: () => setup.show() }] : [],
    keepAwake: (title = 'Keep screen awake'): MenuItemConstructorOptions => ({
      label: title,
      type: 'checkbox',
      checked: !!settings.keepAwake,
      click: (item) => {
        updateSettings((s) => {
          s.keepAwake = item.checked
        })
        keepAwake(item.checked)
        refreshMenu()
      },
    }),
    openAtLogin: (title = 'Open at login'): MenuItemConstructorOptions => ({
      label: title,
      type: 'checkbox',
      checked: autostart.isEnabled(),
      click: () => {
        if (autostart.isEnabled()) autostart.disable()
        else autostart.enable()
        refreshMenu()
      },
    }),
    shortcuts: shortcutsMenu(),
    update: (title?: string): MenuItemConstructorOptions => ({
      ...update,
      // Only the plain "Check for updates" takes another label: its state shows otherwise.
      ...(title && update.label === 'Check for updates…' && { label: title }),
      click: () => {
        if (update.label.startsWith('Restart')) void updates.restartToUpdate()
        else updates.check(true)
      },
    }),
    installedApps: (title = 'Installed apps'): MenuItemConstructorOptions[] => {
      // The apps installed on this computer (app-windows.ts): each opens, or uninstalls, from
      // here too, even once it is gone from the library.
      const list = installedApps.list()
      if (!list.length) return []
      const workspaces = new Set(list.map((a) => a.workspaceId)).size > 1
      return [
        {
          label: title,
          submenu: list.map((a) => ({
            label: a.name,
            ...(workspaces && a.workspaceName && { sublabel: a.workspaceName }),
            submenu: [
              { label: 'Open', click: () => void appWindows.openInstall(a.installId) },
              { label: 'Uninstall…', click: () => void appWindows.uninstall(a.installId) },
            ],
          })),
        },
      ]
    },
    restartRunner: (title = 'Restart runner'): MenuItemConstructorOptions => ({
      label: title,
      click: () => void ctx.supervisor.start(),
    }),
    showLogs: (title = 'Show logs'): MenuItemConstructorOptions => ({
      label: title,
      click: showLogs,
    }),
  }
}

function trayMenu() {
  const it = items()
  const template: MenuItemConstructorOptions[] = [
    it.status,
    ...(it.runs ? [it.workspace] : []),
    { type: 'separator' },
    // The actions first: what the menu is opened for. Then the dashboard, then settings.
    it.newThread(),
    ...it.screenshot(),
    { type: 'separator' },
    it.openDashboard(),
    it.openInBrowser(),
    ...it.installedApps(),
    ...it.setUp(),
    { type: 'separator' },
    it.keepAwake(),
    it.openAtLogin(),
    it.shortcuts,
    { type: 'separator' },
    it.update(),
    ...(it.runs ? [it.restartRunner(), it.showLogs()] : []),
    { type: 'separator' },
    {
      label: 'Quit Brigade',
      ...(process.platform === 'darwin' && {
        accelerator: 'Command+Q',
        registerAccelerator: false,
      }),
      click: () => app.quit(),
    },
  ]
  return Menu.buildFromTemplate(template)
}

/** The count beside the menu-bar icon, while the draft has captures. */
function showCount() {
  if (!tray) return
  const count = capture.names().length
  if (process.platform === 'darwin') tray.setTitle(count > 0 ? String(count) : '')
  else
    tray.setToolTip(count > 0 ? `Brigade · ${count} screenshot${count > 1 ? 's' : ''}` : 'Brigade')
}

let pending = false

/** Built again on the next tick: several changes at once make one menu. */
export function refreshMenu() {
  if (pending) return
  pending = true
  setImmediate(() => {
    pending = false
    setAppMenu()
    if (!tray || tray.isDestroyed()) return
    tray.setContextMenu(trayMenu())
    showCount()
  })
}

export function createTray() {
  const icon =
    process.platform === 'darwin'
      ? // trayTemplate.png and @2x: macOS draws a template image in the menu bar's colors.
        nativeImage.createFromPath(join(assets, 'trayTemplate.png'))
      : nativeImage.createFromPath(join(assets, '32x32.png'))
  tray = new Tray(icon)
  tray.setToolTip('Brigade')
  tray.setContextMenu(trayMenu())
  showCount()
  // Windows opens the menu on a right click only; a left click opens it too.
  if (process.platform === 'win32') tray.on('click', () => tray?.popUpContextMenu())
}

/**
 * macOS's app menu, live while one of Brigade's windows is in front: what the menu-bar menu
 * holds, laid out as on a Mac. Brigade: About, updates, settings and this Mac's runner; File:
 * the actions. Electron's default menu quits on ⌘Q, runner and all; here ⌘Q closes only the
 * window, and Brigade stays in the menu bar (Quit Brigade quits). Edit keeps copy and paste
 * working; View reloads and goes back in the dashboard.
 */
export function setAppMenu() {
  if (process.platform !== 'darwin') return Menu.setApplicationMenu(null)
  const it = items()
  const front = () => BrowserWindow.getFocusedWindow()
  // The page in front: the dashboard's page when its window is in front, even with the keyboard in
  // the find bar over it (find.ts), else the focused page, else the window's own.
  const page = () => {
    const window = front()
    const shown = dashboardContents()
    if (window && window === dashboardWindow() && shown) return shown
    return webContents.getFocusedWebContents() ?? window?.webContents
  }
  const runner: MenuItemConstructorOptions[] = it.runs
    ? [it.workspace, it.restartRunner('Restart Runner'), it.showLogs('Show Logs')]
    : []
  const setUp = it.setUp('Set Up Brigade…')
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Brigade',
        submenu: [
          { role: 'about' },
          it.update('Check for Updates…'),
          { type: 'separator' },
          it.openAtLogin('Open at Login'),
          it.keepAwake('Keep Screen Awake'),
          it.shortcuts,
          ...(runner.length || setUp.length
            ? [{ type: 'separator' } as const, ...runner, ...setUp]
            : []),
          { type: 'separator' },
          { label: 'Close Window', accelerator: 'Command+Q', click: () => front()?.close() },
          { label: 'Quit Brigade', click: () => app.quit() },
        ],
      },
      {
        label: 'File',
        submenu: [
          it.newThread('New Thread'),
          ...it.screenshot('Take a Screenshot'),
          { type: 'separator' },
          it.openDashboard('Open Dashboard'),
          it.openInBrowser('Open in Browser'),
          ...it.installedApps('Installed Apps'),
        ],
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'pasteAndMatchStyle' },
          { role: 'selectAll' },
          { type: 'separator' },
          // The keys reach the page first, which opens the bar unless it uses them itself
          // (preload.ts): shown here, not taken from it.
          {
            label: 'Find…',
            accelerator: 'Command+F',
            registerAccelerator: false,
            click: () => void openFind(),
          },
          {
            label: 'Find Next',
            accelerator: 'Command+G',
            registerAccelerator: false,
            click: () => void findAgain(true),
          },
          {
            label: 'Find Previous',
            accelerator: 'Shift+Command+G',
            registerAccelerator: false,
            click: () => void findAgain(false),
          },
        ],
      },
      {
        label: 'View',
        submenu: [
          { label: 'Reload', accelerator: 'Command+R', click: () => page()?.reload() },
          {
            label: 'Back',
            accelerator: 'Command+[',
            click: () => page()?.navigationHistory.goBack(),
          },
          {
            label: 'Forward',
            accelerator: 'Command+]',
            click: () => page()?.navigationHistory.goForward(),
          },
          { type: 'separator' },
          { label: 'Actual Size', accelerator: 'Command+0', click: () => page()?.setZoomLevel(0) },
          {
            label: 'Zoom In',
            accelerator: 'Command+Plus',
            click: () => page()?.setZoomLevel((page()?.getZoomLevel() ?? 0) + 0.5),
          },
          {
            label: 'Zoom Out',
            accelerator: 'Command+-',
            click: () => page()?.setZoomLevel((page()?.getZoomLevel() ?? 0) - 0.5),
          },
          { type: 'separator' },
          {
            label: 'Toggle Developer Tools',
            accelerator: 'Alt+Command+I',
            click: () => page()?.toggleDevTools(),
          },
        ],
      },
      { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }] },
    ]),
  )
}
