// The apps installed on this computer (docs/apps.md, Installed apps): a library app the person
// installed from its menu in the dashboard, which then opens in a window of its own from its own
// icon (a bundle in ~/Applications/Brigade Apps on macOS, a Start menu shortcut on Windows, a
// launcher entry on Linux). Kept in Brigade.app's settings (settings.ts), one entry per install.
// What is here is plain data and names, tested on its own; app-windows.ts does the rest.
import { randomBytes } from 'node:crypto'
import { loadSettings, updateSettings, type Settings } from './settings.js'

export type InstalledApp = {
  /** 16 random bytes, hex: names the bundle's id, the shortcut's AppUserModelID, `--app=`. */
  installId: string
  /** The app's `index.html` document id, which stays when the app moves in the library. */
  appId: string
  /** Its library folder when it was installed (or last opened): what opens if the id is gone. */
  path: string
  /** The name it was installed under, as its icon shows it. */
  name: string
  /** The workspace it was installed from: its window opens there. */
  workspaceId: string
  workspaceName: string
  /** What was written for it: the .app bundle, the .lnk or the .desktop file. */
  installedPath: string
  /** macOS: the cdhash of the bundle's ad hoc signature, which a connecting shim must have. */
  cdhash?: string
  /** Where its icon was kept (Windows' .ico, Linux's .png), in Brigade.app's own folder. */
  iconPath?: string
  installedAt: string
}

/** What the dashboard sees of an install (the bridge's `apps.installed()`). */
export type InstalledAppInfo = Pick<
  InstalledApp,
  'appId' | 'path' | 'name' | 'workspaceId' | 'workspaceName'
>

export const info = (app: InstalledApp): InstalledAppInfo => ({
  appId: app.appId,
  path: app.path,
  name: app.name,
  workspaceId: app.workspaceId,
  workspaceName: app.workspaceName,
})

export const newInstallId = () => randomBytes(16).toString('hex')

export const validInstallId = (id: unknown): id is string =>
  typeof id === 'string' && /^[0-9a-f]{32}$/.test(id)

const text = (v: unknown, max = 500): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max

/** The entries of the settings that are whole; anything else is left out. */
export function listIn(settings: Settings): InstalledApp[] {
  const raw = settings.installedApps
  if (!Array.isArray(raw)) return []
  return raw.filter((a): a is InstalledApp => {
    if (!a || typeof a !== 'object') return false
    const e = a as Record<string, unknown>
    return (
      validInstallId(e.installId) &&
      text(e.appId, 200) &&
      text(e.path, 2000) &&
      text(e.name, 200) &&
      text(e.workspaceId, 200) &&
      typeof e.workspaceName === 'string' &&
      text(e.installedPath, 4000) &&
      (e.cdhash === undefined || (typeof e.cdhash === 'string' && /^[0-9a-f]{40}$/.test(e.cdhash)))
    )
  })
}

export const list = () => listIn(loadSettings())

export const byInstallId = (id: string) => list().find((a) => a.installId === id)

/** The install of an app (by its document id), if it is installed. */
export const byAppId = (appId: string) => list().find((a) => a.appId === appId)

export function save(app: InstalledApp) {
  updateSettings((s) => {
    s.installedApps = [...listIn(s).filter((a) => a.installId !== app.installId), app]
  })
}

export function update(installId: string, change: (app: InstalledApp) => void) {
  updateSettings((s) => {
    s.installedApps = listIn(s).map((a) => {
      if (a.installId !== installId) return a
      const copy = { ...a }
      change(copy)
      return copy
    })
  })
}

export function forget(installId: string) {
  updateSettings((s) => {
    s.installedApps = listIn(s).filter((a) => a.installId !== installId)
  })
}

/** `--app=<installId>`, from a Start menu shortcut or a launcher entry: which app to open. */
export function appArg(argv: readonly string[]): string | undefined {
  for (const arg of argv) {
    if (!arg.startsWith('--app=')) continue
    const id = arg.slice('--app='.length)
    if (validInstallId(id)) return id
  }
  return undefined
}

/** Brigade.app started by an app's shim (macOS), with Brigade itself closed. */
export const APP_SHIM_FLAG = '--app-shim'

/**
 * Names that would pass for Brigade's, Apple's or the system's own apps in the Dock, the Start
 * menu or Spotlight: they get " (App)", so an app made in a thread can't pose as one.
 */
const RESERVED = [
  'brigade',
  'apple',
  'macos',
  'mac os',
  'os x',
  'finder',
  'safari',
  'system settings',
  'system preferences',
  'settings',
  'app store',
  'keychain access',
  'passwords',
  'terminal',
  'activity monitor',
  'mail',
  'messages',
  'facetime',
  'photos',
  'calendar',
  'contacts',
  'notes',
  'reminders',
  'music',
  'launchpad',
  'mission control',
  'spotlight',
  'siri',
  'icloud',
  'windows',
  'microsoft',
  'file explorer',
  'explorer',
  'control panel',
  'task manager',
  'command prompt',
  'powershell',
  'microsoft edge',
  'google chrome',
  'chrome',
  'firefox',
  '1password',
]
/** Words that pose as a vendor's app whatever follows ("Apple Pay", "Brigade Helper"). */
const RESERVED_PREFIXES = ['brigade', 'apple', 'macos', 'microsoft', 'windows', 'icloud']

const RESERVED_GLUED =
  /^(brigade|apple|macos|microsoft|icloud)(helper|update|updater|settings|support|app|pay|id)$/

export function imitates(name: string) {
  const plain = name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s._-]+/g, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .trim()
  const squashed = plain.replace(/ /g, '')
  if (RESERVED.some((r) => plain === r || squashed === r.replace(/ /g, ''))) return true
  // As a first word ("Apple Pay"), or glued to the next ("BrigadeHelper"), not inside another
  // word ("Applesauce").
  return RESERVED_PREFIXES.some(
    (p) => plain === p || plain.startsWith(`${p} `) || RESERVED_GLUED.test(squashed),
  )
}

/** A title as a file name on every system: no separators, nothing Windows refuses, not hidden. */
export function fileName(title: string) {
  const cleaned = title
    .normalize('NFC')
    // Control characters, path separators and what Windows refuses in a name.
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Not hidden, not "..", and Windows drops trailing dots and spaces.
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
  const short = [...cleaned].slice(0, 60).join('').trim()
  // Windows' reserved device names, alone or before an extension.
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(short)) return `${short} app`
  return short || 'App'
}

/**
 * The name an app is installed under: its title as a file name, " (<workspace>)" when an app of
 * that name from another workspace is installed already, " (App)" when it imitates a system or
 * vendor app. A file already there takes " 2", " 3"… (`taken`), never written over.
 */
export function installName(
  title: string,
  workspace: { id: string; name: string },
  installed: readonly Pick<InstalledApp, 'name' | 'workspaceId'>[],
  taken: (name: string) => boolean,
) {
  let base = fileName(title)
  const clash = installed.some(
    (a) => a.workspaceId !== workspace.id && a.name.toLowerCase() === base.toLowerCase(),
  )
  if (clash && workspace.name.trim()) base = fileName(`${base} (${workspace.name.trim()})`)
  if (imitates(base)) base = `${base} (App)`
  for (let n = 1; n < 1000; n++) {
    const name = n === 1 ? base : `${base} ${n}`
    if (!taken(name)) return name
  }
  throw new Error('No free name for this app')
}
