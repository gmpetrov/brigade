// What Brigade.app keeps beside the runner's files: ~/.brigade/desktop.json, the same file
// (and keys) as the Tauri app before it, so an update keeps every choice.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_DASHBOARD = 'https://www.brigade.lol/app'

/** ~/.brigade, or $BRIGADE_HOME: the runner install, Brigade.app's own files, and the home of
 * the first workspace linked. Others have homes of their own (workspaces.ts). */
export function home() {
  return process.env.BRIGADE_HOME || join(process.env.HOME || homedir(), '.brigade')
}

export const logFile = () => join(home(), 'logs', 'runner.log')

export type Settings = {
  dashboardUrl?: string | null
  /** Open at login was turned on once, on the first launch; after that it is the person's choice. */
  loginSet?: boolean
  /** Keep screen awake, off until the person turns it on. */
  keepAwake?: boolean
  /** The screenshot shortcut picked in the menu; null for the default. */
  captureShortcut?: string | null
  /** The new thread shortcut picked in the menu; null for the default. */
  newThreadShortcut?: string | null
  /** Where the dashboard window was last, to open it there again. */
  dashboardBounds?: { x: number; y: number; width: number; height: number } | null
  /** Keys a newer or older app wrote: kept as they are. */
  [key: string]: unknown
}

const file = () => join(home(), 'desktop.json')

export function loadSettings(): Settings {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file(), 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Settings)
      : {}
  } catch {
    return {}
  }
}

/** Written whole, through a temporary file, so a crash never leaves half of it. */
export function saveSettings(settings: Settings) {
  try {
    mkdirSync(home(), { recursive: true })
    const temp = `${file()}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(settings, null, 2))
    renameSync(temp, file())
  } catch {}
}

export function updateSettings(change: (settings: Settings) => void) {
  const settings = loadSettings()
  change(settings)
  saveSettings(settings)
}

/** The dashboard's address, e.g. https://www.brigade.lol/app: the one the last link named. */
export function dashboard() {
  const url = loadSettings().dashboardUrl
  return typeof url === 'string' && allowedDashboard(url)
    ? url.replace(/\/+$/, '')
    : DEFAULT_DASHBOARD
}

/** A dashboard a link may set: https, or a local one while developing Brigade. */
export function allowedDashboard(url: string) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:') return true
    return parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname)
  } catch {
    return false
  }
}

/**
 * Whether `url` is on the dashboard's site: its origin, or the same host with or without
 * `www.` (brigade.lol sends to www.brigade.lol). Its pages, and only them, get the bridge.
 */
export function onDashboard(url: string, dashboardUrl = dashboard()) {
  try {
    const page = new URL(url)
    const home = new URL(dashboardUrl)
    if (page.protocol !== home.protocol || page.port !== home.port) return false
    const bare = (host: string) => host.replace(/^www\./, '')
    return bare(page.hostname) === bare(home.hostname)
  } catch {
    return false
  }
}
