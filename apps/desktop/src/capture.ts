// The new thread window and the screenshot shortcut. The shortcut (⌘⇧2 unless changed in the
// menu) is macOS's own selection, taken by Brigade Computer Use (it holds Screen Recording,
// Brigade.app doesn't), added to a draft in ~/.brigade/captures. A small window shows the draft:
// the dashboard's /app/capture page, the web new-thread box, which reads the captures through
// the bridge (preload.ts) and starts a thread with them. The new thread shortcut (⌘⇧1 unless
// changed) opens the same window as it is, with no screenshot. Closing the window keeps the
// draft; the menu-bar icon counts its captures until it is sent.
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, globalShortcut, shell } from 'electron'
import { ctx } from './context.js'
import { alert } from './dialogs.js'
import { dashboard, home, loadSettings, onDashboard, updateSettings } from './settings.js'
import * as shortcuts from './shortcuts.js'
import {
  bringUp,
  dashboardPreferences,
  dashboardWindow,
  guard,
  showDashboard,
  signedInElsewhere,
  type WindowKind,
} from './windows.js'

/** How long the person may take to pick what to capture. */
const SELECTING_MS = 10 * 60_000

/** The window's header row moves it: it has no title bar on macOS (new-thread.tsx marks it). */
const DRAG_CSS = `[data-window-drag]{-webkit-app-region:drag}
[data-window-drag] :is(a,button,input,select,textarea,label,[role],[contenteditable="true"]){-webkit-app-region:no-drag}`

export const dir = () => join(home(), 'captures')

/** A capture's file name: its time in milliseconds, so they sort as taken. */
export const valid = (name: string) => /^\d+\.png$/.test(name)

/** The draft's captures, oldest first. */
export function names() {
  let entries: string[] = []
  try {
    entries = readdirSync(dir())
  } catch {}
  return entries.filter(valid).sort((a, b) => Number(a.slice(0, -4)) - Number(b.slice(0, -4)))
}

export const read = (name: string) => {
  if (!valid(name)) throw new Error('no such capture')
  return readFileSync(join(dir(), name))
}

export function remove(name: string) {
  if (valid(name)) rmSync(join(dir(), name), { force: true })
  ctx.refreshMenu()
}

/** Sent: the draft starts over. */
export function clear() {
  for (const name of names()) rmSync(join(dir(), name), { force: true })
  ctx.refreshMenu()
}

let window: BrowserWindow | undefined
/** A selection is on screen: the shortcuts do nothing. */
let taking = false

export const captureWindow = () => (window && !window.isDestroyed() ? window : undefined)

/** The draft's window, opened the first time and kept loaded after: closing only hides it. */
export function show() {
  const url = `${dashboard()}/capture`
  const open = captureWindow()
  if (open) {
    // The dashboard changed (a link from another one): the window goes there.
    if (!onDashboard(open.webContents.getURL())) void open.loadURL(url)
    bringUp(open)
    open.webContents.send('brigade:capture-shown')
    return
  }
  const mac = process.platform === 'darwin'
  const created = new BrowserWindow({
    width: 560,
    height: 400,
    minWidth: 420,
    minHeight: 300,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    show: false,
    title: 'New thread',
    autoHideMenuBar: true,
    // No title bar on macOS: the window buttons sit at the start of the page's "New thread for…"
    // row (about 52pt tall), which leaves room for them and moves the window.
    ...(mac && { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 16, y: 19 } }),
    webPreferences: dashboardPreferences(),
  })
  window = created
  guard(created.webContents, 'capture')
  if (mac) created.setAlwaysOnTop(true, 'floating')
  if (process.platform !== 'win32')
    created.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  if (mac) created.webContents.on('dom-ready', () => void created.webContents.insertCSS(DRAG_CSS))
  created.on('close', (event) => {
    if (ctx.quitting) return
    event.preventDefault()
    created.hide()
  })
  created.on('closed', () => {
    if (window === created) window = undefined
  })
  created.once('ready-to-show', () => bringUp(created))
  void created.loadURL(url)
}

export function hide() {
  captureWindow()?.hide()
}

/** The shortcut: a selection, then the draft's window with it added. Esc during the selection
 * adds nothing. */
export async function take() {
  if (taking) return
  taking = true
  const name = `${Date.now()}.png`
  mkdirSync(dir(), { recursive: true })
  // The draft's window stays above everything: out of the way of what is captured.
  const open = captureWindow()
  const wasOpen = !!open?.isVisible()
  open?.hide()
  let reply: Record<string, unknown>
  try {
    reply = await ctx.helper.call('capture', { path: join(dir(), name) }, SELECTING_MS)
  } catch (error) {
    taking = false
    const message = (error as Error).message
    // The helper's own words are for a teammate; the person turns it on in setup.
    await alert(
      'Could not take a screenshot',
      message.startsWith('Screen Recording is off')
        ? "Brigade Computer Use needs Screen Recording to take screenshots. Open Set up Brigade… in Brigade's menu to turn it on."
        : message,
      'error',
    )
    return
  }
  taking = false
  if (reply.cancelled === true) {
    if (open && wasOpen && !open.isDestroyed()) bringUp(open)
    return
  }
  ctx.refreshMenu()
  show()
  captureWindow()?.webContents.send('brigade:capture-added', name)
}

/** Which shortcut of each kind is registered now, for the menu. */
export const registered: Partial<Record<shortcuts.Kind, string>> = {}

function pressed(kind: shortcuts.Kind) {
  if (kind === 'screenshot') return void take()
  // A screenshot's selection is on screen: the window would cover it.
  if (!taking) show()
}

/** The shortcuts chosen in the menu, registered; an alert for each kind in `report` that
 * another app holds. */
export function applyShortcuts(report: shortcuts.Kind[] = []) {
  globalShortcut.unregisterAll()
  const settings = loadSettings()
  for (const kind of shortcuts.kinds()) {
    const value = shortcuts.chosen(kind, settings)
    const accelerator = shortcuts.accelerator(value)
    let done = false
    if (accelerator)
      try {
        done = globalShortcut.register(accelerator, () => pressed(kind))
      } catch {}
    registered[kind] = done ? value : undefined
    if (accelerator && !done && report.includes(kind)) {
      const title = shortcuts.title(kind)
      void alert(
        `${title} shortcut unavailable`,
        `Another app already uses ${shortcuts.labelOf(kind, value)}. Pick another one in Brigade's menu, under Shortcuts › ${title}.`,
        'warning',
      )
    }
  }
  ctx.refreshMenu()
}

/** From the menu: remembered, then registered. */
export function chooseShortcut(kind: shortcuts.Kind, value: string) {
  if (!shortcuts.choices(kind).some((c) => c.id === value)) return
  updateSettings((settings) => shortcuts.remember(kind, value, settings))
  applyShortcuts([kind])
}

const onSignInPage = (window: BrowserWindow | undefined) => {
  try {
    return !!window && new URL(window.webContents.getURL()).pathname === '/sign-in'
  } catch {
    return false
  }
}

/** One window signed in: the other shares its session, and leaves its sign-in page for home. */
signedInElsewhere((from) => {
  const main = dashboardWindow()
  const capture = captureWindow()
  if (main && main.webContents !== from && onSignInPage(main)) void main.loadURL(dashboard())
  if (capture && capture.webContents !== from && onSignInPage(capture))
    void capture.loadURL(`${dashboard()}/capture`)
})

/** A sign-in through the browser, started by a window: its secret, and which window. */
let signIn: { verifier: string; window: WindowKind } | undefined

const base64url = (bytes: Buffer) => bytes.toString('base64url')

/**
 * The window signs in through the browser, where the member likely is already: the app has
 * cookies of its own. The browser gets the hash of a secret kept here, and sends back a code
 * (`signedIn`) that only that secret redeems (desktop-sign-in.ts in the API).
 */
export async function startSignIn(from: WindowKind) {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  signIn = { verifier, window: from }
  const url = new URL(`${dashboard()}/desktop-sign-in`)
  url.searchParams.set('challenge', challenge)
  await shell.openExternal(url.toString())
}

/** brigade://sign-in?code=…, from the browser: the window's sign-in page redeems the code with
 * the secret. Without a sign-in started here, the link does nothing. */
export function signedIn(code: string) {
  if (!signIn) return
  const url = new URL('/sign-in', dashboard())
  url.searchParams.set('desktop_code', code)
  url.searchParams.set('verifier', signIn.verifier)
  if (signIn.window === 'main') return showDashboard(url.toString())
  show()
  void captureWindow()?.loadURL(url.toString())
}
