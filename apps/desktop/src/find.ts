// Find in the dashboard's page (⌘F; Ctrl+F on Windows and Linux), as in a browser: a small bar
// over the page's top right, with what it found ("2/7") and the next and previous ones. The bar
// is a view of its own (page/find.html) over the dashboard's, so the search never finds the
// words typed in its own field, and the dashboard's page is left as it is.
//
// The dashboard's page opens it (preload.ts: ⌘F the page itself left alone, so a code editor's
// own search still wins), and on macOS the Edit menu (menu.ts).
import { join } from 'node:path'
import {
  type BrowserWindow,
  ipcMain,
  type IpcMainEvent,
  type Rectangle,
  WebContentsView,
  type WebContents,
} from 'electron'

/** The bar's view: its card, and room around it for the card's shadow. */
export const FIND_SIZE = { width: 372, height: 60 }
/** Below the dashboard's top bar, at its right. */
const TOP = 40
const RIGHT = 6

type Bar = {
  view: WebContentsView
  /** The bar's own page. */
  own: WebContents
  /** The dashboard's page it searches. */
  page: WebContents
  ready: Promise<void>
  open: boolean
  text: string
  /** The last search asked: results of older ones are dropped. */
  request: number
  /** The page changed since the last search started: the next one starts over. */
  stale: boolean
}

let bar: Bar | undefined
let dark = true

const live = () => (bar && !bar.own.isDestroyed() && !bar.page.isDestroyed() ? bar : undefined)

/** Adds the bar, hidden, to the dashboard window, over `page`. */
export function attachFind(window: BrowserWindow, page: WebContents) {
  const view = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, 'find-preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })
  view.setBackgroundColor('#00000000')
  view.setVisible(false)
  window.contentView.addChildView(view)
  const own = view.webContents
  own.on('will-navigate', (event) => event.preventDefault())
  own.setWindowOpenHandler(() => ({ action: 'deny' }))
  const ready = new Promise<void>((resolve) => own.once('did-finish-load', () => resolve()))
  void own.loadFile(join(__dirname, '..', 'page', 'find.html'))
  void ready.then(() => !own.isDestroyed() && own.send('find:theme', dark))

  const state: Bar = { view, own, page, ready, open: false, text: '', request: 0, stale: false }
  bar = state
  page.on('found-in-page', (_event, result) => {
    if (bar !== state || own.isDestroyed() || result.requestId !== state.request) return
    own.send('find:result', { active: result.activeMatchOrdinal, matches: result.matches })
  })
  // Another page: what was found went with the old one, and so does the bar, as in a browser.
  page.on('did-navigate', () => bar === state && closeFind(false))
  // The dashboard moved within its page (another thread): the next search starts over.
  page.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
    if (isMainFrame) state.stale = true
  })
  window.on('closed', () => {
    if (bar === state) bar = undefined
    if (!own.isDestroyed()) own.close()
  })
}

/** Keeps the bar at the top right of the dashboard's view, as the window resizes. */
export function placeFind(page: Rectangle) {
  const state = live()
  if (!state) return
  const width = Math.min(FIND_SIZE.width, page.width)
  state.view.setBounds({
    x: page.x + Math.max(0, page.width - width - RIGHT),
    y: page.y + TOP,
    width,
    height: FIND_SIZE.height,
  })
}

/** The bar in the page's theme. */
export function setFindTheme(isDark: boolean) {
  dark = isDark
  const state = live()
  if (state)
    void state.ready.then(() => !state.own.isDestroyed() && state.own.send('find:theme', dark))
}

/** Shows the bar with the keyboard in its field, its text selected to type over. */
export async function openFind() {
  const state = live()
  if (!state) return
  const reopened = !state.open
  state.open = true
  if (reopened) state.page.send('brigade:find-open', true)
  state.view.setVisible(true)
  await state.ready
  if (state.own.isDestroyed() || state.page.isDestroyed()) return
  state.own.focus()
  state.own.send('find:open', state.text)
  // Closing took the highlights away: they come back, from the match it was on.
  if (reopened && state.text) search(state, state.text)
}

/** The next match (⌘G), or the previous one; the bar shows again if it was closed. */
export async function findAgain(forward = true) {
  const state = live()
  if (!state) return
  if (!state.open) return openFind()
  step(state, forward)
}

/** Hides the bar; the match it was on stays selected in the page, which gets the keyboard back. */
export function closeFind(focusPage = true) {
  const state = live()
  if (!state || !state.open) return
  state.open = false
  state.page.send('brigade:find-open', false)
  state.view.setVisible(false)
  state.page.stopFindInPage('keepSelection')
  if (focusPage) state.page.focus()
}

export const findOpen = () => !!live()?.open

function search(state: Bar, text: string) {
  state.text = text
  state.stale = false
  if (!text) {
    state.request = 0
    state.page.stopFindInPage('clearSelection')
    state.own.send('find:result', { active: 0, matches: 0 })
    return
  }
  state.request = state.page.findInPage(text, { findNext: true })
}

function step(state: Bar, forward: boolean) {
  if (!state.text) return
  if (state.stale) return search(state, state.text)
  state.request = state.page.findInPage(state.text, { forward, findNext: false })
}

/** What the bar's page asks (find-preload.ts), from that page alone. */
export function registerFind() {
  const sender = (event: IpcMainEvent) => {
    const state = live()
    return state && event.sender === state.own ? state : undefined
  }
  ipcMain.on('find:search', (event, text: unknown) => {
    const state = sender(event)
    if (state && typeof text === 'string') search(state, text.slice(0, 1000))
  })
  ipcMain.on('find:step', (event, forward: unknown) => {
    const state = sender(event)
    if (state) step(state, forward !== false)
  })
  ipcMain.on('find:close', (event) => {
    if (sender(event)) closeFind()
  })
}
