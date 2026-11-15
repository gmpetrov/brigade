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
import * as autostart from './autostart.js'
import * as capture from './capture.js'
import { ctx } from './context.js'
import { confirm } from './dialogs.js'
import { showLogs } from './logs.js'
import { label, runnerSupported } from './runner.js'
import { dashboard, loadSettings, updateSettings } from './settings.js'
import * as setup from './setup.js'
import * as shortcuts from './shortcuts.js'
import * as updates from './updates.js'
import { showDashboard } from './windows.js'
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
function action(kind: shortcuts.Kind, click: () => void): MenuItemConstructorOptions {
  const keys = capture.registered[kind]
  return {
    label: shortcuts.actionLabel(kind),
    click,
    ...(keys && { accelerator: shortcuts.accelerator(keys), registerAccelerator: false }),
  }
}

function trayMenu() {
  const runs = runnerSupported()
  const update = updates.menuItem()
  const settings = loadSettings()
  const template: MenuItemConstructorOptions[] = [
    { label: label(ctx.supervisor.status), enabled: false },
    ...(runs ? [workspaceMenu()] : []),
    { type: 'separator' },
    // The actions first: what the menu is opened for. Then the dashboard, then settings.
    action('newThread', () => capture.show()),
    ...(shortcuts.kinds().includes('screenshot')
      ? [action('screenshot', () => void capture.take())]
      : []),
    { type: 'separator' },
    { label: 'Open dashboard', click: () => showDashboard() },
    { label: 'Open in browser', click: () => void shell.openExternal(dashboard()) },
    ...(setup.hasSetup() ? [{ label: 'Set up Brigade…', click: () => setup.show() }] : []),
    { type: 'separator' },
    {
      label: 'Keep screen awake',
      type: 'checkbox',
      checked: !!settings.keepAwake,
      click: (item) => {
        updateSettings((s) => {
          s.keepAwake = item.checked
        })
        keepAwake(item.checked)
      },
    },
    {
      label: 'Open at login',
      type: 'checkbox',
      checked: autostart.isEnabled(),
      click: () => {
        if (autostart.isEnabled()) autostart.disable()
        else autostart.enable()
        refreshMenu()
      },
    },
    shortcutsMenu(),
    { type: 'separator' },
    {
      ...update,
      click: () => {
        if (update.label.startsWith('Restart')) void updates.restartToUpdate()
        else updates.check(true)
      },
    },
    ...(runs
      ? [
          { label: 'Restart runner', click: () => void ctx.supervisor.start() },
          { label: 'Show logs', click: showLogs },
        ]
      : []),
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
 * macOS's app menu, live while one of Brigade's windows is in front. Electron's default one
 * quits on ⌘Q, runner and all; here ⌘Q closes only that window, and Brigade stays in the menu
 * bar. Edit keeps copy and paste working; View reloads and goes back in the dashboard.
 */
export function setAppMenu() {
  if (process.platform !== 'darwin') return Menu.setApplicationMenu(null)
  const front = () => BrowserWindow.getFocusedWindow()
  // The page in front: the dashboard's view in its window (windows.ts), else the window's own.
  const page = () => webContents.getFocusedWebContents() ?? front()?.webContents
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Brigade',
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { label: 'Open dashboard', click: () => showDashboard() },
          { type: 'separator' },
          { label: 'Close Window', accelerator: 'Command+Q', click: () => front()?.close() },
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
