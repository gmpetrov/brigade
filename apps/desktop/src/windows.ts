// The windows that show the dashboard: the dashboard itself, and the new thread window
// (capture.ts). Both load the live dashboard (www.brigade.lol), share one session, and get the
// bridge (preload.ts). Their pages stay on the dashboard's site: any other address opens in the
// browser, where the person's passwords and sessions are, and providers' sign-ins work.
import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  screen,
  session,
  shell,
  type WebContents,
  type WebPreferences,
} from 'electron'
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

let main: BrowserWindow | undefined

export const dashboardWindow = () => (main && !main.isDestroyed() ? main : undefined)

/** Brings a window to the front with the keyboard in its page, so typing and Esc reach it. */
export function bringUp(window: BrowserWindow) {
  if (process.platform === 'darwin') app.focus({ steal: true })
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  window.webContents.focus()
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

/** The dashboard in a window of its own, at `url` (the dashboard's home by default). */
export function showDashboard(url = dashboard()) {
  const open = dashboardWindow()
  if (open) {
    if (url !== dashboard() || !onDashboard(open.webContents.getURL())) void open.loadURL(url)
    return bringUp(open)
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
    webPreferences: dashboardPreferences(),
  })
  main = window
  guard(window.webContents, 'main')
  // A Dock icon while the dashboard is open; the menu bar alone otherwise, as before.
  if (process.platform === 'darwin') void app.dock?.show()
  window.once('ready-to-show', () => bringUp(window))
  window.on('close', () => {
    const bounds = window.getNormalBounds()
    updateSettings((settings) => {
      settings.dashboardBounds = bounds
    })
  })
  window.on('closed', () => {
    if (main === window) main = undefined
    if (process.platform === 'darwin') app.dock?.hide()
  })
  // Offline or the dashboard down: a page that says so and tries again.
  window.webContents.on('did-fail-load', (_event, code, description, failed, isMainFrame) => {
    // -3: a navigation replaced by another one, not a failure.
    if (!isMainFrame || code === -3) return
    void window.loadFile(join(__dirname, '..', 'page', 'offline.html'), {
      query: { url: failed, reason: description },
    })
  })
  if (process.platform !== 'darwin') {
    // No menu bar there: the usual keys to reload and go back.
    window.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      const key = input.key.toLowerCase()
      const history = window.webContents.navigationHistory
      if (key === 'f5' || (input.control && key === 'r')) window.webContents.reload()
      else if (input.alt && key === 'arrowleft' && history.canGoBack()) history.goBack()
      else if (input.alt && key === 'arrowright' && history.canGoForward()) history.goForward()
      else if (input.control && input.shift && key === 'i') window.webContents.toggleDevTools()
      else return
      event.preventDefault()
    })
  }
  void window.loadURL(url)
}
