// The theme a member wears (docs/themes.md), applied to this window: its colour tokens on the
// page, its stylesheet after the dashboard's own, its files from the bucket's signed addresses.
// Kept in this browser too, so the next page shows it from its first paint. ?safe-look in the
// address keeps a tab without it; the reset shortcut takes it off everywhere.
import { SAFE_LOOK_PARAM, ThemeFile, type WornTheme } from '@brigade/contracts'
import { applyThemeCss } from './theme-css'
import { themeTokens, type Mode } from './theme-palette'

const CACHE_KEY = 'brigade:theme'
/** The worn theme's tokens, checked, for THEME_FIRST_PAINT to put on the page before it paints. */
export const PAINT_KEY = 'brigade:theme-paint'
const SAFE_KEY = 'brigade:safe-look'

/**
 * Run in the page's head (app/layout.tsx): the worn theme's colour tokens, as this browser kept
 * them, before the first paint. Its stylesheet and light or dark mode follow once the page runs.
 */
export const THEME_FIRST_PAINT = `try{if(/^\\/app(\\/|$)/.test(location.pathname)&&sessionStorage.getItem('${SAFE_KEY}')!=='1'&&!/[?&]${SAFE_LOOK_PARAM}(=|&|$)/.test(location.search)){var p=JSON.parse(localStorage.getItem('${PAINT_KEY}')||'null');if(p&&p.vars){var s=document.documentElement.style;for(var k in p.vars)if(/^[a-z0-9-]+$/.test(k))s.setProperty('--'+k,String(p.vars[k]))}}}catch(e){}`

type State = { worn: NonNullable<WornTheme> | null; mode: Mode | null; safe: boolean }
let state: State = { worn: null, mode: null, safe: false }
const listeners = new Set<() => void>()
/** The custom properties set on the page, to take off again. */
let setVars: string[] = []

export const subscribeTheme = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
export const themeState = () => state
const serverState: State = { worn: null, mode: null, safe: false }
export const serverThemeState = () => serverState

function setState(next: Partial<State>) {
  state = { ...state, ...next }
  for (const listener of listeners) listener()
}

const storage = (kind: 'localStorage' | 'sessionStorage'): Storage | null => {
  try {
    return typeof window === 'undefined' ? null : window[kind]
  } catch {
    return null
  }
}

/** Whether this tab keeps the dashboard's own look: opened with ?safe-look, until it closes. */
export function safeLook(): boolean {
  if (typeof window === 'undefined') return false
  const params = new URLSearchParams(window.location.search)
  if (params.has(SAFE_LOOK_PARAM)) storage('sessionStorage')?.setItem(SAFE_KEY, '1')
  return storage('sessionStorage')?.getItem(SAFE_KEY) === '1'
}

/** Leave safe look in this tab: the theme applies again. */
export function leaveSafeLook() {
  storage('sessionStorage')?.removeItem(SAFE_KEY)
  setState({ safe: false })
  if (state.worn) paint(state.worn)
}

function unpaint() {
  const root = document.documentElement
  for (const name of setVars) root.style.removeProperty(`--${name}`)
  setVars = []
  applyThemeCss('', {})
  delete root.dataset.theme
  storage('localStorage')?.removeItem(PAINT_KEY)
}

/** Put a worn theme on this page. Checked again here: what the browser kept may be anything. */
function paint(worn: NonNullable<WornTheme>) {
  const parsed = ThemeFile.safeParse(worn.theme)
  unpaint()
  if (!parsed.success) {
    setState({ mode: null })
    return
  }
  const { mode, vars } = themeTokens(parsed.data)
  const root = document.documentElement
  for (const [name, value] of Object.entries(vars)) {
    root.style.setProperty(`--${name}`, value)
    setVars.push(name)
  }
  root.dataset.theme = worn.id
  storage('localStorage')?.setItem(PAINT_KEY, JSON.stringify({ vars }))
  applyThemeCss(parsed.data.css ?? '', worn.files)
  setState({ mode })
}

/** Off this window, kept for its next page: the dashboard left (a public page) or not open to them. */
export function leaveWindow() {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  for (const name of setVars) root.style.removeProperty(`--${name}`)
  setVars = []
  applyThemeCss('', {})
  delete root.dataset.theme
  setState({ mode: null })
}

/** Wear `worn` in this window (null: the dashboard's own look), and keep it for the next page. */
export function wearInWindow(worn: WornTheme) {
  if (typeof document === 'undefined') return
  const cache = storage('localStorage')
  if (worn) cache?.setItem(CACHE_KEY, JSON.stringify(worn))
  else cache?.removeItem(CACHE_KEY)
  setState({ worn })
  if (state.safe || !worn) {
    unpaint()
    setState({ mode: null })
    return
  }
  paint(worn)
}

/** The dashboard's pages, the only ones a theme dresses: never the site's public pages. */
export const inDashboard = () =>
  typeof window !== 'undefined' && /^\/app(\/|$)/.test(window.location.pathname)

/** At the page's start: the theme this browser kept, before the API says which. */
export function startTheme() {
  if (typeof document === 'undefined' || !inDashboard()) return
  const safe = safeLook()
  setState({ safe })
  // What the head's script put on the page, to take off should the theme change.
  try {
    const painted = JSON.parse(storage('localStorage')?.getItem(PAINT_KEY) ?? 'null') as {
      vars?: Record<string, string>
    } | null
    if (!safe && painted?.vars) setVars = Object.keys(painted.vars)
  } catch {
    storage('localStorage')?.removeItem(PAINT_KEY)
  }
  const kept = storage('localStorage')?.getItem(CACHE_KEY)
  if (!kept) return
  try {
    const worn = JSON.parse(kept) as NonNullable<WornTheme>
    setState({ worn })
    if (!safe) paint(worn)
  } catch {
    storage('localStorage')?.removeItem(CACHE_KEY)
  }
}

/** When the files' addresses of the worn theme stop working: ask again a while before. */
export function refreshDelay(worn: WornTheme, now = Date.now()): number | null {
  if (!worn) return null
  const expires = Date.parse(worn.expires)
  if (Number.isNaN(expires)) return null
  return Math.max(60_000, expires - now - 60 * 60_000)
}

/** Goes up with each load of the worn theme, and when the look changes here: an older answer is dropped. */
let loadGeneration = 0

/** Answers of loads still on their way no longer apply: the look was just changed here. */
export const invalidateThemeLoads = () => {
  loadGeneration++
}

/**
 * Loads the worn theme and wears it, again before its files' addresses run out. Only the latest
 * load's answer applies: one that comes back after a newer load, after the look changed here
 * (invalidateThemeLoads) or after `stop`, is dropped, so an older look never replaces a newer one.
 */
export function themeLoader<T>(io: {
  fetch: () => Promise<WornTheme>
  wear: (worn: WornTheme) => void
  schedule: (run: () => void, ms: number) => T
  cancel: (timer: T | undefined) => void
}) {
  let timer: T | undefined
  const load = async (): Promise<void> => {
    const mine = ++loadGeneration
    io.cancel(timer)
    let worn: WornTheme
    try {
      worn = await io.fetch()
    } catch {
      // Offline or refused: the look kept in this browser stays until the next try.
      return
    }
    if (mine !== loadGeneration) return
    io.wear(worn)
    const delay = refreshDelay(worn)
    if (delay !== null) timer = io.schedule(() => void load(), delay)
  }
  return {
    load,
    stop: () => {
      invalidateThemeLoads()
      io.cancel(timer)
    },
  }
}

/** The reset shortcut: ⌘⌥⇧R on a Mac, Ctrl+Alt+Shift+R elsewhere. */
export const isResetLookKey = (
  event: Pick<KeyboardEvent, 'code' | 'altKey' | 'shiftKey' | 'metaKey' | 'ctrlKey'>,
) => event.code === 'KeyR' && event.altKey && event.shiftKey && (event.metaKey || event.ctrlKey)

startTheme()
