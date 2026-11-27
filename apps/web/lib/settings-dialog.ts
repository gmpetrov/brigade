// Settings is a dialog over the page the member is on (components/settings-dialog.tsx). Each
// section keeps its address, /app/<section>, which opens it: a link to it inside the app opens
// the dialog in place (clickSettings, openSettings), and loaded on its own (a new tab, a
// provider's redirect, an email) it opens over Today. What followed `?` in the address goes to
// the section (useSettingsParams), as it would have to a page.
import { useSyncExternalStore, type MouseEvent } from 'react'

/**
 * Settings' sections, in their groups: the member's own, the workspace's, what teammates work with.
 * `settings` names what a section holds, by the title it shows (its group or row, whose anchor
 * settingAnchor makes from it), so a search finds it inside the section and goes to it.
 */
export const SETTINGS_SECTIONS = [
  {
    section: 'profile',
    label: 'Profile',
    group: 'You',
    keywords: 'account me name photo picture avatar email',
    settings: [
      { label: 'Name', keywords: 'display rename' },
      { label: 'Picture', keywords: 'photo avatar image' },
      { label: 'Email', keywords: 'address sign in google' },
      { label: 'Danger zone', keywords: '' },
      { label: 'Delete my account', keywords: 'remove' },
    ],
  },
  {
    section: 'preferences',
    label: 'Preferences',
    group: 'You',
    keywords: 'pass',
    settings: [
      { label: 'Teammates', keywords: '' },
      { label: 'Suggest my next message', keywords: 'suggestions autocomplete tab' },
      { label: 'Auto-merge when ready', keywords: 'pull request merge' },
      {
        label: 'Keep heavy work off the shared computer',
        keywords: 'machine preview builds renders vcpu',
      },
      { label: 'Chief', keywords: '' },
      { label: 'Your rules', keywords: 'chief' },
      { label: 'Daily pass', keywords: 'chief morning' },
      {
        label: 'Appearance',
        keywords: 'theme themes look colours colors dark light font style restyle',
        feature: 'themes',
      },
      {
        label: 'Suggested themes',
        keywords: 'appearance midnight matrix synthwave amber paper blueprint retro',
        feature: 'themes',
      },
      { label: 'Import a theme', keywords: 'appearance', feature: 'themes' },
    ],
  },
  {
    section: 'notifications',
    label: 'Notifications',
    group: 'You',
    keywords: 'push alerts phone',
    settings: [
      { label: 'This device', keywords: 'browser push' },
      { label: 'Notify me about', keywords: 'preset' },
    ],
  },
  {
    section: 'accounts',
    label: 'AI Accounts',
    group: 'You',
    keywords: 'claude codex chatgpt subscription sign in',
    settings: [],
  },
  {
    section: 'workspace',
    label: 'General',
    group: 'Workspace',
    keywords: 'workspace name logo',
    // In the app's search, where "General" alone would say nothing.
    search: 'Workspace',
    settings: [{ label: 'Danger zone', keywords: 'delete workspace' }],
  },
  {
    section: 'members',
    label: 'Members',
    group: 'Workspace',
    keywords: 'invite role people email',
    settings: [{ label: 'Invited', keywords: 'invitations pending' }],
  },
  {
    section: 'computers',
    label: 'Computers',
    group: 'Workspace',
    keywords: 'cloud computer machine link desktop mac windows linux',
    settings: [],
  },
  {
    section: 'usage',
    label: 'Usage',
    group: 'Workspace',
    keywords: 'limits spent models threads routines subscriptions',
    settings: [],
  },
  {
    section: 'billing',
    label: 'Billing',
    group: 'Workspace',
    keywords: 'plan brigade cloud subscribe invoices card',
    settings: [],
  },
  {
    section: 'connections',
    label: 'Connected apps',
    group: 'Teammates',
    keywords: 'connections connect integrations mcp triggers github gmail',
    settings: [],
  },
  {
    section: 'skills',
    label: 'Skills',
    group: 'Teammates',
    keywords: 'procedures instructions',
    settings: [],
  },
  {
    section: 'vault',
    label: 'Secrets',
    group: 'Teammates',
    keywords: 'vault credentials passwords logins keys',
    settings: [],
  },
  {
    section: 'security',
    label: 'Security',
    group: 'Teammates',
    keywords: 'access permissions activity',
    settings: [],
  },
] as const satisfies readonly {
  section: string
  label: string
  group: string
  keywords: string
  search?: string
  settings: readonly SettingEntry[]
}[]

/** A setting inside a section: shown only to members with its `feature`, when it has one. */
type SettingEntry = { label: string; keywords: string; feature?: string }

/** The anchor of a setting a section shows under `title` (SettingsGroup, SettingRow): `data-setting`. */
export const settingAnchor = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]['section']

/** A section's address, at one of its settings (its anchor) when given. */
export const settingsHref = (section: SettingsSection, setting?: string) =>
  `/app/${section}${setting ? `#${setting}` : ''}`

/**
 * Settings open on a section, with what its address had after `?`, scrolled to the setting its
 * `#` names.
 */
export type SettingsShown = {
  section: SettingsSection
  params: URLSearchParams
  setting: string | null
}

const SECTIONS = new Set<string>(SETTINGS_SECTIONS.map((s) => s.section))

/**
 * The section an address opens, or null for any other address: /app/settings opens the first.
 * A full URL counts only on this site.
 */
export function settingsAddress(href: string): SettingsShown | null {
  let url: URL
  try {
    url = new URL(href, 'https://here.invalid')
  } catch {
    return null
  }
  if (url.origin !== 'https://here.invalid' && url.origin !== currentOrigin()) return null
  const name = /^\/app\/([^/]+)\/?$/.exec(url.pathname)?.[1]
  const section = name === 'settings' ? SETTINGS_SECTIONS[0].section : name
  if (!section || !SECTIONS.has(section)) return null
  return {
    section: section as SettingsSection,
    params: url.searchParams,
    setting: decodeURIComponent(url.hash.slice(1)) || null,
  }
}

const currentOrigin = () => (typeof location === 'undefined' ? undefined : location.origin)

/** A setting a search found inside its section. */
export type FoundSetting = { label: string; anchor: string }

/**
 * The sections a search finds, each word in its name, group or what it holds, with the settings
 * inside it the search found (none for an empty search). `features` are the member's: a setting
 * behind one they lack is not searched.
 */
export function searchSettings(query: string, features: readonly string[] = []) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const matches = (text: string) => words.every((w) => text.toLowerCase().includes(w))
  return SETTINGS_SECTIONS.flatMap((s) => {
    const settings: FoundSetting[] = !words.length
      ? []
      : (s.settings as readonly SettingEntry[])
          .filter((e) => !e.feature || features.includes(e.feature))
          .filter((e) => matches(`${e.label} ${e.keywords}`))
          .map((e) => ({ label: e.label, anchor: settingAnchor(e.label) }))
    const own = matches(`${s.label} ${s.group} ${s.section} ${s.keywords}`)
    return own || settings.length ? [{ ...s, settings }] : []
  })
}

let shown: SettingsShown | null = null
const listeners = new Set<() => void>()
function show(next: SettingsShown | null) {
  shown = next
  listeners.forEach((l) => l())
}
function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/**
 * The dialogs mounted to show Settings (SettingsDialog). A page without one, such as Brigade.app's
 * quick-capture window (/app/capture, outside the dashboard's shell), opens nothing in place: its
 * links to a section go to its address instead.
 */
let hosts = 0
export function hostSettings() {
  hosts++
  return () => void hosts--
}

/**
 * Open Settings in place, on the section an address names (the first by default), or move it to
 * that section. Returns false, doing nothing, for an address that is no section's, or where no
 * dialog shows Settings: the caller then goes to the address.
 */
export function openSettings(href = '/app/settings') {
  const at = settingsAddress(href)
  if (!at || !hosts) return false
  show(at)
  return true
}

/**
 * Settings on the section an address names, even before the dialog mounts: a section's address
 * loaded on its own (SettingsAddress), whose dialog mounts after it.
 */
export function showSettings(href: string) {
  const at = settingsAddress(href)
  if (at) show(at)
}

export function closeSettings() {
  show(null)
}

/** The section shown, or null while Settings is closed. */
export function useSettings() {
  return useSyncExternalStore(
    subscribe,
    () => shown,
    () => null,
  )
}

const NONE = new URLSearchParams()

/** What the section's address had after `?` (`?app=cloudflare`, `?subscribed=1`): a section's useSearchParams. */
export function useSettingsParams() {
  return useSettings()?.params ?? NONE
}

/**
 * A link's onClick: a plain click on a section's address opens it in place; one that opens a new
 * tab or window (or that a child already took), and any other address, is left as it is.
 */
export function clickSettings(e: MouseEvent<HTMLAnchorElement>, href: string) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
    return
  if (openSettings(href)) e.preventDefault()
}

/**
 * Where a section's address loaded on its own leaves the window: Settings over Today (`behind`),
 * the address becoming /app. Brigade.app's quick-capture window shows only /app/capture, and
 * turns /app back into it, which would take Settings away: there the address stays, Settings
 * over it, and closing them goes back to the capture page (`closed`).
 */
export function addressLanding(captureWindow: boolean): {
  behind: string | null
  closed: string | null
} {
  return captureWindow ? { behind: null, closed: '/app/capture' } : { behind: '/app', closed: null }
}
