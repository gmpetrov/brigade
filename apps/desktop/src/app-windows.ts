// Installed apps (docs/apps.md): a library app installed on this computer, from its menu in the
// dashboard, opens in a window of its own, with its own identity on each system:
//
// - macOS: an app shim (app-install-mac.ts) in ~/Applications/Brigade Apps. Launched, it
//   connects to Brigade.app's shim server; its window is made in the shim's process, so it has
//   its own Dock icon, ⌘-Tab entry, menu bar and badge.
// - Windows: a Start menu shortcut (app-install-win.ts) that starts Brigade with --app=<id>; the
//   window gets the shortcut's AppUserModelID, so the taskbar gives it its own pinnable button.
// - Linux: a launcher entry (app-install-linux.ts) that starts Brigade with --app=<id>; on X11
//   the window's WM_CLASS matches the entry, so the dock groups it under its icon.
//
// The window shows the dashboard's /app/apps/window page, which holds the app alone, in
// Brigade's own session, as the new thread window does (capture.ts). It stays on that page:
// anything else of the dashboard opens in the dashboard window. Its bridge has nothing but
// `info` and the app's badge (ipc.ts, preload.ts).
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  type AppShimHost,
  ipcMain,
  type Rectangle,
  type IpcMainInvokeEvent,
  Menu,
  nativeImage,
  shell,
  type WebContents,
} from 'electron'
import { execFile } from 'node:child_process'
import * as mac from './app-install-mac.js'
import { ctx } from './context.js'
import * as linux from './app-install-linux.js'
import * as win from './app-install-win.js'
import { alert, confirm } from './dialogs.js'
import * as installed from './installed-apps.js'
import { sessionType } from './linux/input.js'
import {
  appWindowBounds,
  startInstallAnimation,
  type InstallAnimation,
} from './install-animation.js'
import { dashboard, onDashboard } from './settings.js'
import {
  dashboardContents,
  dashboardPreferences,
  dashboardWindow,
  guard,
  kindOf,
  pageRectOnScreen,
  showDashboard,
} from './windows.js'

type Entry = installed.InstalledApp

/** The page an app's window shows, on the dashboard. */
export const APP_WINDOW_PATH = '/app/apps/window'

/** An app's window, by its install id. */
const windows = new Map<string, BrowserWindow>()
/** macOS: the shims connected now, by install id. */
const shims = new Map<string, AppShimHost>()
/** An app's window is being made: Brigade's own Dock icon stays hidden for it (--app-shim). */
let making = false
/** Apps just installed, whose first window opens where their animation leads. */
const arriving = new Map<string, { animation: InstallAnimation | null; bounds: Rectangle }>()
/** Apps being installed now (by document id): a second Install meanwhile does nothing. */
const installing = new Set<string>()

const own = (window: BrowserWindow | undefined) =>
  window && !window.isDestroyed() ? window : undefined

/** The install whose window this page is in. */
export function installOf(contents: WebContents) {
  for (const [id, window] of windows) if (own(window)?.webContents === contents) return id
  return undefined
}

/** Where an app's window goes: the app by its document id, in the workspace it came from. */
export function appUrl(entry: Pick<Entry, 'path' | 'appId' | 'workspaceId'>, base = dashboard()) {
  const url = new URL(`${base.replace(/\/app$/, '')}${APP_WINDOW_PATH}`)
  url.searchParams.set('path', entry.path)
  url.searchParams.set('id', entry.appId)
  url.searchParams.set('workspace', entry.workspaceId)
  return url.toString()
}

const onAppPage = (url: string) => {
  try {
    return onDashboard(url) && new URL(url).pathname === APP_WINDOW_PATH
  } catch {
    return false
  }
}

/** Brigade's own folder for what installs need (staging bundles, icons). */
const appsDir = () => join(app.getPath('userData'), 'Installed apps')

/** Tells the dashboard's pages the list changed (the app's menu shows Install or Uninstall). */
function changed() {
  const list = currentList().map(installed.info)
  for (const contents of [dashboardContents()]) contents?.send('brigade:apps:changed', list)
  // Brigade's own menu lists them too.
  ctx.refreshMenu?.()
}

/** The list, without installs whose bundle, shortcut or entry was deleted by hand. */
function currentList() {
  const list = installed.list()
  const gone = list.filter((a) => !existsSync(a.installedPath))
  for (const a of gone) forgetLocal(a)
  return list.filter((a) => !gone.includes(a))
}

function forgetLocal(entry: Entry) {
  installed.forget(entry.installId)
  if (entry.iconPath) rmSync(entry.iconPath, { force: true })
  own(windows.get(entry.installId))?.close()
  shims.get(entry.installId)?.quit()
}

// The window ---------------------------------------------------------------------------------

function appMenu(entry: Entry, window: () => BrowserWindow | undefined) {
  const page = () => own(window())?.webContents
  return Menu.buildFromTemplate([
    {
      label: entry.name,
      submenu: [
        { label: 'Open in Brigade', click: () => openInBrigade(entry) },
        { label: 'Uninstall…', click: () => void uninstall(entry.installId) },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'Command+R', click: () => page()?.reload() },
        { type: 'separator' },
        { label: 'Actual Size', accelerator: 'Command+0', click: () => page()?.setZoomLevel(0) },
        {
          label: 'Zoom In',
          accelerator: 'Command+Plus',
          click: () => {
            const p = page()
            if (p) p.setZoomLevel(p.getZoomLevel() + 0.5)
          },
        },
        {
          label: 'Zoom Out',
          accelerator: 'Command+-',
          click: () => {
            const p = page()
            if (p) p.setZoomLevel(p.getZoomLevel() - 0.5)
          },
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ])
}

/**
 * The app in the dashboard window, in the library: by its document id (wherever it moved), in
 * the workspace it was installed from, which the dashboard switches to for it.
 */
function openInBrigade(entry: Entry) {
  const url = new URL(`${dashboard()}/library`)
  url.searchParams.set('app-id', entry.appId)
  url.searchParams.set('workspace', entry.workspaceId)
  showDashboard(url.toString())
}

function bringUp(window: BrowserWindow) {
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  window.webContents.focus()
}

/** Opens the app's window, or brings it up; on macOS in its shim, which must be connected. */
async function openWindow(entry: Entry, shim?: AppShimHost) {
  const open = own(windows.get(entry.installId))
  if (open) return bringUp(open)
  const linuxIcon =
    process.platform === 'linux' && entry.iconPath
      ? nativeImage.createFromPath(entry.iconPath)
      : undefined
  const arrival = arriving.get(entry.installId)
  arriving.delete(entry.installId)
  making = true
  let window: BrowserWindow
  try {
    window = new BrowserWindow({
      width: 1100,
      height: 760,
      ...arrival?.bounds,
      minWidth: 360,
      minHeight: 280,
      show: false,
      title: entry.name,
      autoHideMenuBar: true,
      backgroundColor: '#1a1a1e',
      ...(shim && { appShim: shim }),
      ...(process.platform === 'win32' && entry.iconPath && { icon: entry.iconPath }),
      ...(linuxIcon && !linuxIcon.isEmpty() && { icon: linuxIcon }),
      webPreferences: dashboardPreferences(),
    })
  } finally {
    making = false
  }
  windows.set(entry.installId, window)
  const contents = window.webContents
  guard(contents, 'app')
  // The app's page alone: the rest of the dashboard opens in its own window.
  contents.on('will-navigate', (event, url) => {
    if (event.defaultPrevented || onAppPage(url) || !onDashboard(url)) return
    event.preventDefault()
    showDashboard(url)
  })
  // Its title is the app's, whatever the page says.
  contents.on('page-title-updated', (event) => event.preventDefault())
  if (process.platform === 'win32')
    window.setAppDetails({
      appId: win.appUserModelId(entry.installId),
      ...(entry.iconPath && { appIconPath: entry.iconPath, appIconIndex: 0 }),
      relaunchCommand: win.relaunchCommand(process.execPath, entry.installId),
      relaunchDisplayName: entry.name,
    })
  if (process.platform === 'linux' && sessionType() === 'x11')
    await linux.setWmClass(window.getNativeWindowHandle(), linux.wmClass(entry.installId))
  window.once('ready-to-show', () => {
    // Just installed: it shows as its animation opens out to it.
    if (!arrival?.animation) return bringUp(window)
    void arrival.animation.go(arrival.bounds).then(() => !window.isDestroyed() && bringUp(window))
  })
  window.on('closed', () => {
    if (windows.get(entry.installId) === window) windows.delete(entry.installId)
    // macOS: the shim goes with its last window, as a web app's does.
    if (shim?.isConnected()) shim.quit()
  })
  void contents.loadURL(appUrl(entry))
}

// macOS's shims -----------------------------------------------------------------------------

/** Starts the shim server (macOS): installed apps connect to it as they launch. */
export function startShimServer() {
  if (process.platform !== 'darwin') return
  app.on('app-shim-connected', (_event, shim) => void connected(shim))
  app.on('app-shim-version-mismatch', (_event, bundlePath) => void mismatch(bundlePath))
  try {
    app.startAppShimServer({ name: mac.SHIM_SERVER })
  } catch (error) {
    console.error('app shims:', error)
  }
}

/**
 * A shim connected. Any process of this account may connect, so it gets a window only when its
 * bundle names an install of the list and the running process has that install's exact ad hoc
 * signature (its cdhash, which binds its Info.plist too); anything else is told to quit.
 */
async function connected(shim: AppShimHost) {
  const id = mac.plistValue(shim.bundlePath, 'BrigadeAppInstallId')
  const entry = id && installed.validInstallId(id) ? installed.byInstallId(id) : undefined
  let trusted = false
  try {
    trusted = !!entry?.cdhash && shim.satisfiesCodeRequirement(`cdhash H"${entry.cdhash}"`)
  } catch {}
  if (!entry || !trusted) return shim.quit()
  shims.set(entry.installId, shim)
  // Moved by hand (out of the folder, renamed): followed, so Open launches it there.
  if (mac.real(shim.bundlePath) !== mac.real(entry.installedPath))
    installed.update(entry.installId, (a) => {
      a.installedPath = shim.bundlePath
    })
  const current = installed.byInstallId(entry.installId) ?? entry
  shim.setApplicationMenu(appMenu(current, () => windows.get(current.installId)))
  // A click on its Dock icon, or launched again: its window, made again if it was closed.
  shim.on('activate', () => void openWindow(current, shim))
  shim.on('disconnected', () => {
    if (shims.get(current.installId) === shim) shims.delete(current.installId)
    own(windows.get(current.installId))?.destroy()
  })
  await openWindow(current, shim)
}

/** Brigade.app was updated while it runs: the shims load the new framework and can't connect. */
async function mismatch(bundlePath: string) {
  const name = installed.list().find((a) => a.installedPath === bundlePath)?.name ?? 'This app'
  const restart = await confirm({
    title: 'Restart Brigade to open this app',
    message: `Brigade was updated while it was running. ${name} opens once Brigade restarts.`,
    ok: 'Restart Brigade',
    cancel: 'Later',
  })
  if (!restart) return
  app.relaunch()
  app.quit()
}

// Install, open, uninstall -------------------------------------------------------------------

export type InstallInput = {
  appId: string
  path: string
  title: string
  iconPng: Uint8Array
  workspaceId: string
  workspaceName: string
  /** The app's pane in the dashboard's page, where the install animation starts. */
  from?: Rectangle
}

const MAX_ICON = 8 * 1024 * 1024

export function parseInstall(input: unknown): InstallInput | undefined {
  if (!input || typeof input !== 'object') return undefined
  const i = input as Record<string, unknown>
  const text = (v: unknown, max: number) => typeof v === 'string' && v.trim() && v.length <= max
  if (!text(i.appId, 200) || !text(i.path, 2000) || !text(i.title, 200)) return undefined
  if (!text(i.workspaceId, 200) || typeof i.workspaceName !== 'string') return undefined
  if (!(i.iconPng instanceof Uint8Array) || !i.iconPng.length || i.iconPng.length > MAX_ICON)
    return undefined
  return {
    appId: String(i.appId),
    path: String(i.path),
    title: String(i.title).trim(),
    iconPng: i.iconPng,
    workspaceId: String(i.workspaceId),
    workspaceName: String(i.workspaceName).slice(0, 200),
    ...(rectangle(i.from) && { from: rectangle(i.from) }),
  }
}

/** A rectangle of the page, in its pixels, if it is one. */
export function rectangle(value: unknown): Rectangle | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { x, y, width, height } = value as Record<string, unknown>
  const n = (v: unknown, min: number) =>
    typeof v === 'number' && Number.isFinite(v) && v >= min && v < 100_000
  if (!n(x, -100_000) || !n(y, -100_000) || !n(width, 1) || !n(height, 1)) return undefined
  return { x: x as number, y: y as number, width: width as number, height: height as number }
}

const WHERE: Record<string, string> = {
  darwin:
    'It opens in its own window, with its own icon in the Dock, from ~/Applications/Brigade Apps.',
  win32:
    'It opens in its own window, with its own taskbar button, from the Start menu under Brigade Apps.',
  linux: 'It opens in its own window, from your app launcher.',
}

/** From the app's menu in the dashboard: asked here, outside the page, then installed and opened. */
export async function install(input: InstallInput): Promise<installed.InstalledAppInfo | null> {
  const already = currentList().find((a) => a.appId === input.appId)
  if (already) {
    await openApp(already)
    return installed.info(already)
  }
  if (installing.has(input.appId)) return null
  installing.add(input.appId)
  try {
    return await installing_(input)
  } finally {
    installing.delete(input.appId)
  }
}

async function installing_(input: InstallInput): Promise<installed.InstalledAppInfo | null> {
  const yes = await confirm({
    title: `Install “${input.title}” as an app?`,
    message: `${WHERE[process.platform] ?? WHERE.linux} It shows only the app, signed in as you.`,
    ok: 'Install',
  })
  if (!yes) return null
  // Installed meanwhile (another of the dashboard's pages asked too): it opens.
  const meanwhile = currentList().find((a) => a.appId === input.appId)
  if (meanwhile) {
    await openApp(meanwhile)
    return installed.info(meanwhile)
  }
  // The picture, read and written again: only an image goes on.
  const image = nativeImage.createFromBuffer(Buffer.from(input.iconPng))
  if (image.isEmpty()) throw new Error('The app’s icon could not be read.')
  const square = image.resize({ width: 1024, height: 1024, quality: 'best' })
  // The animation starts from the app's pane, while the app is made.
  const pane = (input.from && pageRectOnScreen(input.from)) ?? dashboardWindow()?.getContentBounds()
  const bounds = appWindowBounds(pane ?? { x: 0, y: 0, width: 1, height: 1 })
  const animation = pane
    ? startInstallAnimation(
        pane,
        square.resize({ width: 512, height: 512, quality: 'best' }).toPNG(),
      )
    : null
  try {
    const entry = await make(input, square)
    arriving.set(entry.installId, { animation, bounds })
    await openApp(entry)
    return installed.info(entry)
  } catch (error) {
    animation?.cancel()
    throw error
  }
}

/** Writes the system's own entry for the app, and keeps it in the list. */
async function make(input: InstallInput, square: Electron.NativeImage): Promise<Entry> {
  const installId = installed.newInstallId()
  const dir = appsDir()
  mkdirSync(dir, { recursive: true })
  const workspace = { id: input.workspaceId, name: input.workspaceName }
  const list = currentList()
  let entry: Entry
  if (process.platform === 'darwin') {
    const folder = mac.appsFolder()
    const name = installed.installName(input.title, workspace, list, (n) =>
      existsSync(join(folder, `${n}.app`)),
    )
    const png = join(dir, `${installId}.png`)
    writeFileSync(png, square.toPNG())
    try {
      const built = await mac.buildShim({ installId, name, iconPng: png, staging: dir })
      entry = record(input, installId, name, built.bundle, { cdhash: built.cdhash })
    } finally {
      rmSync(png, { force: true })
    }
    await mac.register(entry.installedPath)
  } else if (process.platform === 'win32') {
    const folder = win.startMenuFolder()
    mkdirSync(folder, { recursive: true })
    const name = installed.installName(input.title, workspace, list, (n) =>
      existsSync(join(folder, `${n}.lnk`)),
    )
    const ico = join(dir, `${installId}.ico`)
    writeFileSync(
      ico,
      win.encodeIco(
        win.ICO_SIZES.map((size) => [
          size,
          square.resize({ width: size, height: size, quality: 'best' }).toPNG(),
        ]),
      ),
    )
    const lnk = join(folder, `${name}.lnk`)
    const ok = shell.writeShortcutLink(lnk, 'create', {
      target: process.execPath,
      args: `--app=${installId}`,
      description: `${name}, an app of Brigade`,
      icon: ico,
      iconIndex: 0,
      appUserModelId: win.appUserModelId(installId),
    })
    if (!ok) {
      rmSync(ico, { force: true })
      throw new Error('The Start menu shortcut could not be written.')
    }
    entry = record(input, installId, name, lnk, { iconPath: ico })
  } else {
    const name = installed.installName(input.title, workspace, list, (n) =>
      list.some((a) => a.name.toLowerCase() === n.toLowerCase()),
    )
    const png = join(dir, `${installId}.png`)
    writeFileSync(png, square.resize({ width: 512, height: 512, quality: 'best' }).toPNG())
    const folder = linux.applicationsFolder()
    mkdirSync(folder, { recursive: true })
    const file = join(folder, linux.entryName(installId))
    writeFileSync(
      file,
      linux.desktopEntry({ installId, name, exec: linux.launcherPath(), icon: png }),
      // A new install id's file: never one already there, nor a link's target.
      { flag: 'wx' },
    )
    execFile('update-desktop-database', [folder], () => {})
    entry = record(input, installId, name, file, { iconPath: png })
  }
  changed()
  return entry
}

function record(
  input: InstallInput,
  installId: string,
  name: string,
  installedPath: string,
  extra: Partial<Entry>,
) {
  const entry: Entry = {
    installId,
    appId: input.appId,
    path: input.path,
    name,
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
    installedPath,
    installedAt: new Date().toISOString(),
    ...extra,
  }
  installed.save(entry)
  // Brigade's settings could not be written (a full disk, a locked file): what was just made is
  // taken back, rather than left as an icon Brigade does not know.
  if (!installed.byInstallId(installId)) {
    rmSync(installedPath, { recursive: true, force: true })
    if (extra.iconPath) rmSync(extra.iconPath, { force: true })
    throw new Error('Brigade could not save its settings, so the app was not installed.')
  }
  return entry
}

/**
 * Whether what the list names is still what Brigade wrote for this install: the bundle with its
 * install id and its signature, the shortcut or the launcher entry naming it. A file put there
 * since is someone else's: never rewritten, launched or removed.
 */
async function ours(entry: Entry) {
  const path = entry.installedPath
  try {
    // A link could point anywhere: what Brigade wrote is never one.
    if (lstatSync(path).isSymbolicLink()) return false
    if (process.platform === 'darwin')
      return (
        mac.plistValue(path, 'BrigadeAppInstallId') === entry.installId &&
        !!entry.cdhash &&
        (await mac.signedAs(path, entry.cdhash))
      )
    if (process.platform === 'win32')
      return (
        win.inStartMenuFolder(path) &&
        (shell.readShortcutLink(path).args ?? '').split(/\s+/).includes(`--app=${entry.installId}`)
      )
    return (
      linux.isAppEntry(path) && linux.entryInstallId(readFileSync(path, 'utf8')) === entry.installId
    )
  } catch {
    return false
  }
}

/** Opens an installed app: its window, or on macOS its shim, which then gets the window. */
async function openApp(entry: Entry) {
  if (process.platform !== 'darwin') return openWindow(entry)
  const shim = shims.get(entry.installId)
  if (shim?.isConnected()) return openWindow(entry, shim)
  // Launched only when the bundle is still the one installed: never one put in its place.
  if (!(await ours(entry))) {
    forgetLocal(entry)
    changed()
    throw new Error(
      `${entry.name} was removed or changed since it was installed. Install it again.`,
    )
  }
  await mac.launch(entry.installedPath)
}

/** --app=<installId>, from a shortcut or launcher entry (Windows, Linux). */
export async function openInstall(installId: string) {
  const entry = currentList().find((a) => a.installId === installId)
  if (!entry) {
    changed()
    return alert(
      'This app is no longer installed',
      'Install it again from its menu in Brigade, in the library.',
      'warning',
    )
  }
  await openApp(entry).catch((error) =>
    alert('Could not open the app', (error as Error).message, 'error'),
  )
}

/** What went wrong, said by Brigade itself (the page has no room for it): `otherwise` then. */
async function shown<T, O>(title: string, work: () => Promise<T>, otherwise: O): Promise<T | O> {
  try {
    return await work()
  } catch (error) {
    await alert(title, (error as Error).message, 'error')
    return otherwise
  }
}

/** Uninstalls: asked first, then its window closes and only what the list names is removed. */
export function uninstall(installId: string) {
  return shown('Could not uninstall the app', () => uninstalling(installId), false)
}

async function uninstalling(installId: string) {
  const entry = installed.byInstallId(installId)
  if (!entry) return false
  const yes = await confirm({
    title: `Uninstall “${entry.name}”?`,
    message: 'Its window closes and its icon goes. The app stays in the library.',
    ok: 'Uninstall',
  })
  if (!yes) return false
  own(windows.get(installId))?.destroy()
  shims.get(installId)?.quit()
  await removeFiles(entry)
  forgetLocal(entry)
  changed()
  return true
}

async function removeFiles(entry: Entry) {
  const path = entry.installedPath
  // A link put in its place: forgotten, never followed nor removed.
  try {
    if (lstatSync(path).isSymbolicLink())
      throw new Error(`${path} is not what Brigade installed, so it was left as it is.`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (process.platform === 'darwin') {
    if (!(await mac.removeShim(path, entry.installId)))
      throw new Error(`${path} is not an app Brigade installed, so it was left as it is.`)
  } else if (process.platform === 'win32') {
    if (!existsSync(path)) return
    if (!win.inStartMenuFolder(path)) throw new Error(`${path} was left as it is.`)
    let args = ''
    try {
      args = shell.readShortcutLink(path).args ?? ''
    } catch {}
    if (!args.includes(`--app=${entry.installId}`)) throw new Error(`${path} was left as it is.`)
    rmSync(path, { force: true })
  } else {
    if (!existsSync(path)) return
    if (
      !linux.isAppEntry(path) ||
      linux.entryInstallId(readFileSync(path, 'utf8')) !== entry.installId
    )
      throw new Error(`${path} was left as it is.`)
    rmSync(path, { force: true })
    execFile('update-desktop-database', [linux.applicationsFolder()], () => {})
  }
}

/**
 * At start: installs deleted by hand are forgotten, and what names Brigade's path follows it
 * (a moved Brigade.app on macOS, an AppImage's new path on Linux, the executable on Windows).
 */
export async function refreshInstalls() {
  let forgot = false
  for (const entry of currentList()) {
    // Replaced or changed by something else: forgotten, and left as it is.
    if (!(await ours(entry))) {
      forgetLocal(entry)
      forgot = true
      continue
    }
    try {
      if (process.platform === 'darwin') {
        if (!mac.packagedHost()) continue
        const cdhash = await mac.pointAtHost(entry.installedPath)
        if (cdhash)
          installed.update(entry.installId, (a) => {
            a.cdhash = cdhash
          })
      } else if (process.platform === 'win32') {
        const link = shell.readShortcutLink(entry.installedPath)
        if (link.target !== process.execPath)
          shell.writeShortcutLink(entry.installedPath, 'update', { target: process.execPath })
      } else if (entry.iconPath) {
        // Written beside it, then renamed over it: a link put there meanwhile is replaced, never
        // followed.
        const temp = `${entry.installedPath}.${process.pid}.tmp`
        writeFileSync(
          temp,
          linux.desktopEntry({
            installId: entry.installId,
            name: entry.name,
            exec: linux.launcherPath(),
            icon: entry.iconPath,
          }),
          { flag: 'wx' },
        )
        renameSync(temp, entry.installedPath)
      }
    } catch (error) {
      console.error('installed app:', entry.name, error)
    }
  }
  if (forgot) changed()
}

// macOS: started by a shim, with Brigade closed -----------------------------------------------

/**
 * Brigade started for an app (--app-shim on macOS, --app= elsewhere): no window of its own, and
 * on macOS no Dock icon of its own until one of its windows opens.
 */
export function startHidden() {
  if (process.platform !== 'darwin') return
  app.dock?.hide()
  const show = () => {
    app.dock?.show()
    app.off('browser-window-created', created)
  }
  const created = (_event: unknown, window: BrowserWindow) => {
    if (!making && !installOf(window.webContents)) show()
  }
  app.on('browser-window-created', created)
}

// The bridge ---------------------------------------------------------------------------------

export function registerAppsBridge() {
  const fromDashboard = (event: IpcMainInvokeEvent) => {
    const frame = event.senderFrame
    if (!frame || frame !== event.sender.mainFrame || !onDashboard(frame.url)) return false
    return kindOf(event.sender) === 'main'
  }
  ipcMain.handle('brigade:apps:installed', (event) => {
    if (!fromDashboard(event)) throw new Error('Not allowed.')
    return currentList().map(installed.info)
  })
  ipcMain.handle('brigade:apps:install', async (event, input: unknown) => {
    if (!fromDashboard(event)) throw new Error('Not allowed.')
    const parsed = parseInstall(input)
    if (!parsed) throw new Error('This app cannot be installed.')
    return shown('Could not install the app', () => install(parsed), null)
  })
  ipcMain.handle('brigade:apps:open', async (event, appId: unknown) => {
    if (!fromDashboard(event)) throw new Error('Not allowed.')
    const entry = currentList().find((a) => a.appId === appId)
    if (!entry) throw new Error('This app is not installed.')
    await shown('Could not open the app', () => openApp(entry), undefined)
  })
  ipcMain.handle('brigade:apps:uninstall', async (event, appId: unknown) => {
    if (!fromDashboard(event)) throw new Error('Not allowed.')
    const entry = currentList().find((a) => a.appId === appId)
    if (!entry) return false
    return uninstall(entry.installId)
  })
  // The window's own Uninstall (its app was deleted from the library): only for its own app.
  ipcMain.handle('brigade:apps:uninstall-self', (event) => {
    const frame = event.senderFrame
    if (!frame || frame !== event.sender.mainFrame || !onAppPage(frame.url)) return false
    const id = installOf(event.sender)
    return id ? uninstall(id) : false
  })
  // The app's own count, on its Dock icon (macOS), from its page through the window's bridge.
  ipcMain.on('brigade:apps:badge', (event, count: unknown) => {
    const frame = event.senderFrame
    if (!frame || frame !== event.sender.mainFrame || !onAppPage(frame.url)) return
    const id = installOf(event.sender)
    if (!id) return
    const n = Number(count)
    const text = Number.isInteger(n) && n > 0 ? (n > 999 ? '999+' : String(n)) : ''
    shims.get(id)?.setBadge(text)
  })
}
