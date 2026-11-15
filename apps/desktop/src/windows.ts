// The windows that show the dashboard: the dashboard itself, and the new thread window
// (capture.ts). Both load the live dashboard (www.brigade.lol), share one session, and get the
// bridge (preload.ts). Their pages stay on the dashboard's site: any other address opens in the
// browser, where the person's passwords and sessions are, and providers' sign-ins work.
import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  type BrowserWindowConstructorOptions,
  WebContentsView,
  screen,
  session,
  shell,
  type WebContents,
  type WebPreferences,
} from 'electron'
import { ctx } from './context.js'
import { confirm } from './dialogs.js'
import { attachFind, placeFind, setFindTheme } from './find.js'
import { dashboard, loadSettings, onDashboard, updateSettings } from './settings.js'

export type WindowKind = 'main' | 'capture'

const kinds = new WeakMap<WebContents, WindowKind>()
export const kindOf = (contents: WebContents) => kinds.get(contents)

/** brigade:// links clicked in a page ("Open in Brigade"), handled by main.ts. */
let onLink: (url: string) => void = () => {}
export const handleLinks = (handle: (url: string) => void) => {
  onLink = handle
}

/** A dashboard page went from its sign-in page to the dashboard (/app…): signed in. */
let onSignedIn: (from: WebContents) => void = () => {}
export const signedInElsewhere = (handle: (from: WebContents) => void) => {
  onSignedIn = handle
}

export function dashboardPreferences(): WebPreferences {
  return {
    preload: join(__dirname, 'preload.js'),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    spellcheck: true,
  }
}

/** Where an address goes when a page leaves the dashboard or opens a new window. */
export function route(url: string) {
  if (url.startsWith('brigade:')) return onLink(url)
  if (onDashboard(url)) return showDashboard(url)
  if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url)
}

/** Keeps a dashboard page on the dashboard's site. */
export function guard(contents: WebContents, kind: WindowKind) {
  kinds.set(contents, kind)
  contents.on('will-navigate', (event, url) => {
    if (onDashboard(url)) return
    event.preventDefault()
    route(url)
  })
  // From its sign-in page into the dashboard: signed in, for the other window too.
  let path = ''
  const navigated = (url: string) => {
    const previous = path
    path = onDashboard(url) ? new URL(url).pathname : ''
    if (previous === '/sign-in' && path.startsWith('/app')) onSignedIn(contents)
  }
  contents.on('did-navigate', (_event, url) => navigated(url))
  contents.on('did-navigate-in-page', (_event, url, isMainFrame) => isMainFrame && navigated(url))
  contents.on('will-redirect', (event) => {
    if (!event.isMainFrame || onDashboard(event.url)) return
    event.preventDefault()
    route(event.url)
  })
  contents.setWindowOpenHandler(({ url }) => {
    // The dashboard opens a blank tab on the click, then sends it where it goes once the API
    // answers (a provider's sign-in, Stripe, a computer's desktop): a hidden window, which hands
    // that address on as it gets it.
    if (!url || url === 'about:blank')
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          show: false,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        },
      }
    route(url)
    return { action: 'deny' }
  })
  contents.on('did-create-window', (blank) => {
    let handed = false
    const hand = (url: string) => {
      if (handed || !url || url === 'about:blank') return
      handed = true
      route(url)
      setImmediate(() => !blank.isDestroyed() && blank.destroy())
    }
    blank.webContents.on('will-navigate', (event, url) => {
      event.preventDefault()
      hand(url)
    })
    blank.webContents.on('did-start-navigation', (event) => {
      if (event.isMainFrame) hand(event.url)
    })
    // Never sent anywhere: nothing to keep.
    setTimeout(() => !blank.isDestroyed() && blank.destroy(), 120_000).unref()
  })
}

/** The dashboard's pages get what dictation and notifications need, and nothing else. */
export function setUpSession() {
  const allowed = new Set([
    'notifications',
    'clipboard-sanitized-write',
    'clipboard-read',
    'fullscreen',
  ])
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const url = details.requestingUrl || contents.getURL()
    if (!onDashboard(url)) return callback(false)
    // Dictation records the microphone; nothing films.
    if (permission === 'media')
      return callback(!('mediaTypes' in details && details.mediaTypes?.includes('video')))
    callback(allowed.has(permission))
  })
  session.defaultSession.setPermissionCheckHandler((_contents, permission, origin) => {
    if (!onDashboard(origin)) return false
    return permission === 'media' || allowed.has(permission)
  })
  // Chrome's own: sites (Google's sign-in, Cloudflare's checks) turn away an app's.
  session.defaultSession.setUserAgent(
    session.defaultSession
      .getUserAgent()
      .replace(/ Electron\/\S+/, '')
      .replace(new RegExp(` ${app.getName()}/\\S+`), ''),
  )
}

/**
 * How the dashboard window is framed. No title bar on macOS, its traffic lights over the
 * sidebar's first row, and on Windows, whose own buttons sit over the top right; the desktop's
 * own title bar on Linux, where buttons the app drew would match no desktop.
 *
 * The window holds a small page of its own (page/window.html: an empty band that moves the
 * window, in the dashboard's background) and, over it, the dashboard in a view. Where the
 * window's buttons would cover the page (Windows' always, macOS's traffic lights when the page
 * is narrow and has no sidebar), the view starts below them: everything in the dashboard, its
 * fixed panels included, lays out in what is left. On macOS the dashboard otherwise fills the
 * window and makes room for the lights itself (apps/web/lib/desktop-frame.ts).
 */
export type Frame = 'mac' | 'overlay' | 'native'

export const dashboardFrame = (platform = process.platform): Frame =>
  platform === 'darwin' ? 'mac' : platform === 'win32' ? 'overlay' : 'native'

/** Centered on the sidebar's first row: its 36px buttons start 8px down. */
export const TRAFFIC_LIGHTS = { x: 16, y: 19 }
/** The height of Windows' buttons, and of the band above the dashboard. */
export const OVERLAY_HEIGHT = 32
/** The band above a narrow page on macOS, for the traffic lights. */
const MAC_BAND = 32

/** The dashboard's dark background until the page says which theme it shows. */
const DARK = { color: '#1a1a1e', symbolColor: '#e4e4e7' }

function frameOptions(): BrowserWindowConstructorOptions {
  switch (dashboardFrame()) {
    case 'mac':
      return { titleBarStyle: 'hidden', trafficLightPosition: TRAFFIC_LIGHTS }
    case 'overlay':
      return { titleBarStyle: 'hidden', titleBarOverlay: { ...DARK, height: OVERLAY_HEIGHT } }
    default:
      return {}
  }
}

let main: BrowserWindow | undefined
let view: WebContentsView | undefined
/** The page asked for the band above it (macOS, narrow), and the window is in full screen. */
let narrow = false
let fullscreen = false

export const dashboardWindow = () => (main && !main.isDestroyed() ? main : undefined)

/** The dashboard's page in its window. */
export const dashboardContents = () =>
  view && !view.webContents.isDestroyed() ? view.webContents : undefined

/** How far down the dashboard starts: below the band that keeps the window's buttons. */
function band() {
  const frame = dashboardFrame()
  if (frame === 'overlay') return OVERLAY_HEIGHT
  if (frame === 'mac' && narrow && !fullscreen) return MAC_BAND
  return 0
}

function layout() {
  const window = dashboardWindow()
  if (!window || !view) return
  const [width = 0, height = 0] = window.getContentSize()
  const top = band()
  const bounds = { x: 0, y: top, width, height: Math.max(0, height - top) }
  view.setBounds(bounds)
  placeFind(bounds)
  markBand(window)
}

/** The style that sizes the window's own page's band, the height it gives, and the page it
 * went into: the window's page once loaded (`hostPage`, 0 while it loads). */
let bandStyle: { key: string; top: number; page: number } | undefined
let hostPage = 0
let hostPages = 0
let marking = Promise.resolve()

/**
 * The window's own page moves the window only in the band above the view, never under it:
 * macOS gives a drag area's clicks to the window, even where the view covers it, and the
 * dashboard would take no click at all.
 */
function markBand(window: BrowserWindow) {
  const host = window.webContents
  marking = marking
    .then(async () => {
      const top = band()
      const page = hostPage
      if (host.isDestroyed() || !page) return
      if (bandStyle?.page === page && bandStyle.top === top) return
      const key = await host.insertCSS(`#band{height:${top}px !important}`)
      // Reloaded meanwhile: the style went with the old page, the new one marks its own.
      if (page !== hostPage) return
      const previous = bandStyle?.page === page ? bandStyle.key : undefined
      bandStyle = { key, top, page }
      if (previous) await host.removeInsertedCSS(previous)
    })
    .catch(() => {})
}

/** The page's background and text colors: the band's, and Windows' buttons'. */
export function setFrameColors(colors: { color: string; symbolColor: string }) {
  const window = dashboardWindow()
  if (!window) return
  window.setBackgroundColor(colors.color)
  setFindTheme(dark(colors.color))
  if (dashboardFrame() === 'overlay')
    window.setTitleBarOverlay({ ...colors, height: OVERLAY_HEIGHT })
}

/** Whether a #rrggbb background is dark: the find bar follows it. */
export function dark(color: string) {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16))
  return 0.299 * r + 0.587 * g + 0.114 * b < 128
}

/** macOS: the page is too narrow for its sidebar, so the traffic lights get a band above it. */
export function setNarrow(value: boolean) {
  if (dashboardFrame() !== 'mac' || narrow === value) return
  narrow = value
  layout()
}

/** Brings a window to the front with the keyboard in its page, so typing and Esc reach it. */
export function bringUp(window: BrowserWindow, contents: WebContents = window.webContents) {
  if (process.platform === 'darwin') app.focus({ steal: true })
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  contents.focus()
}

/** The bounds it had, while they still fit on a screen. */
function savedBounds() {
  const bounds = loadSettings().dashboardBounds
  if (!bounds || typeof bounds !== 'object') return undefined
  const { x, y, width, height } = bounds
  if (![x, y, width, height].every(Number.isFinite) || width < 400 || height < 300) return undefined
  const area = screen.getDisplayMatching(bounds).workArea
  const visible = x < area.x + area.width - 100 && x + width > area.x + 100 && y >= area.y - 20
  return visible && y < area.y + area.height - 100 ? bounds : undefined
}

let closing: Promise<boolean> | undefined

/**
 * Closes the dashboard window, its page asked first: the page's beforeunload (unsaved file
 * edits, apps/web/lib/code-drafts.ts) keeps it unless the person discards them. Whether it
 * closed. The window only holds the band's page: its own close never reaches the dashboard's.
 */
export function closeDashboard(): Promise<boolean> {
  const window = dashboardWindow()
  if (!window) return Promise.resolve(true)
  const contents = dashboardContents()
  if (!contents) return Promise.resolve(closeWindow(window))
  closing ??= askToClose(window, contents).finally(() => {
    closing = undefined
  })
  return closing
}

function saveBounds(window: BrowserWindow) {
  const bounds = window.getNormalBounds()
  updateSettings((settings) => {
    settings.dashboardBounds = bounds
  })
}

function closeWindow(window: BrowserWindow) {
  if (window.isDestroyed()) return true
  saveBounds(window)
  window.destroy()
  return true
}

function askToClose(window: BrowserWindow, contents: WebContents) {
  return new Promise<boolean>((resolve) => {
    const closed = () => {
      contents.off('will-prevent-unload', kept)
      contents.off('unresponsive', hung)
      resolve(closeWindow(window))
    }
    // The page said no: the person decides.
    const kept = () => {
      contents.off('destroyed', closed)
      contents.off('unresponsive', hung)
      void confirm({
        title: 'Close without saving?',
        message: 'Files you edited in Brigade have changes that are not saved yet.',
        ok: 'Close without saving',
        cancel: 'Keep editing',
        type: 'warning',
      }).then((discard) => {
        if (!discard) return resolve(false)
        if (contents.isDestroyed()) return resolve(closeWindow(window))
        contents.once('destroyed', () => resolve(closeWindow(window)))
        contents.close()
      })
    }
    // A page that does not answer can't keep the window.
    const hung = () => {
      contents.off('will-prevent-unload', kept)
      contents.close()
    }
    contents.once('destroyed', closed)
    contents.once('will-prevent-unload', kept)
    contents.once('unresponsive', hung)
    if (contents.isCrashed()) contents.close()
    else contents.close({ waitForBeforeUnload: true })
  })
}

/** The dashboard in a window of its own, at `url` (the dashboard's home by default). */
export function showDashboard(url = dashboard()) {
  const open = dashboardWindow()
  const shown = dashboardContents()
  if (open && shown) {
    if (url !== dashboard() || !onDashboard(shown.getURL())) void shown.loadURL(url)
    return bringUp(open, shown)
  }
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    ...savedBounds(),
    show: false,
    title: 'Brigade',
    autoHideMenuBar: true,
    backgroundColor: DARK.color,
    ...frameOptions(),
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  const page = new WebContentsView({ webPreferences: dashboardPreferences() })
  page.setBackgroundColor(DARK.color)
  main = window
  view = page
  narrow = false
  fullscreen = false
  window.contentView.addChildView(page)
  // Over the dashboard: the find bar (⌘F), hidden until asked.
  attachFind(window, page.webContents)
  layout()
  window.on('resize', layout)
  // The window's own page: the band, nothing to follow.
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  bandStyle = undefined
  hostPage = 0
  window.webContents.on('did-start-loading', () => {
    hostPage = 0
  })
  window.webContents.on('did-finish-load', () => {
    hostPage = ++hostPages
    markBand(window)
  })
  void window.loadFile(join(__dirname, '..', 'page', 'window.html'))

  const contents = page.webContents
  // Full screen hides the traffic lights: the page gives back the room it kept for them.
  window.on('enter-full-screen', () => {
    fullscreen = true
    layout()
    contents.send('brigade:fullscreen', true)
  })
  window.on('leave-full-screen', () => {
    fullscreen = false
    layout()
    contents.send('brigade:fullscreen', false)
  })
  guard(contents, 'main')
  // A Dock icon while the dashboard is open; the menu bar alone otherwise, as before.
  if (process.platform === 'darwin') void app.dock?.show()
  window.once('ready-to-show', () => bringUp(window, contents))
  // Whether the person is looking: the dashboard's notifications wait meanwhile
  // (apps/web/lib/use-live.ts). The window's, not its page's guess.
  const focusChanged = () => contents.send('brigade:window-focus', window.isFocused())
  window.on('focus', () => {
    contents.focus()
    focusChanged()
  })
  window.on('blur', focusChanged)
  contents.on('dom-ready', focusChanged)
  // The page decides first: it keeps the window open while it has unsaved edits.
  window.on('close', (event) => {
    if (ctx.quitting || contents.isDestroyed()) return saveBounds(window)
    event.preventDefault()
    void closeDashboard()
  })
  window.on('closed', () => {
    if (main === window) {
      main = undefined
      view = undefined
    }
    if (!contents.isDestroyed()) contents.close()
    if (process.platform === 'darwin') app.dock?.hide()
  })
  // Offline or the dashboard down: a page that says so and tries again.
  contents.on('did-fail-load', (_event, code, description, failed, isMainFrame) => {
    // -3: a navigation replaced by another one, not a failure.
    if (!isMainFrame || code === -3) return
    void contents.loadFile(join(__dirname, '..', 'page', 'offline.html'), {
      query: { url: failed, reason: description },
    })
  })
  if (process.platform !== 'darwin') {
    // No menu bar there: the usual keys to reload and go back.
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      const key = input.key.toLowerCase()
      const history = contents.navigationHistory
      if (key === 'f5' || (input.control && key === 'r')) contents.reload()
      else if (input.alt && key === 'arrowleft' && history.canGoBack()) history.goBack()
      else if (input.alt && key === 'arrowright' && history.canGoForward()) history.goForward()
      else if (input.control && input.shift && key === 'i') contents.toggleDevTools()
      else return
      event.preventDefault()
    })
  }
  void contents.loadURL(url)
}
