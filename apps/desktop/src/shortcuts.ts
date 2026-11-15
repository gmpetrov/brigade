// Brigade.app's global shortcuts, each picked in its section of the menu's Shortcuts submenu and
// shown beside its action at the top of the menu. Stored in desktop.json by the same values as
// before (`cmd+shift+2`…), turned into Electron accelerators here.
import type { Settings } from './settings.js'

export type Kind = 'screenshot' | 'newThread'

/** A screenshot needs Brigade Computer Use, which is macOS only. */
export const kinds = (platform = process.platform): Kind[] =>
  platform === 'darwin' ? ['screenshot', 'newThread'] : ['newThread']

type Choice = { id: string; label: string }

/** The shortcuts the menu offers, as stored and as shown; the first is the default. No two
 * kinds offer the same one. */
export function choices(kind: Kind, platform = process.platform): Choice[] {
  const mac = platform === 'darwin'
  if (kind === 'screenshot')
    return [
      { id: 'cmd+shift+2', label: '⌘⇧2' },
      { id: 'ctrl+shift+s', label: '⌃⇧S' },
      { id: 'ctrl+alt+cmd+b', label: '⌃⌥⌘B' },
      { id: 'off', label: 'Off' },
    ]
  return mac
    ? [
        { id: 'cmd+shift+1', label: '⌘⇧1' },
        { id: 'ctrl+alt+cmd+n', label: '⌃⌥⌘N' },
        { id: 'alt+space', label: '⌥Space' },
        { id: 'off', label: 'Off' },
      ]
    : [
        { id: 'ctrl+shift+1', label: 'Ctrl+Shift+1' },
        { id: 'ctrl+alt+n', label: 'Ctrl+Alt+N' },
        { id: 'alt+space', label: 'Alt+Space' },
        { id: 'off', label: 'Off' },
      ]
}

export const title = (kind: Kind) => (kind === 'screenshot' ? 'Screenshot' : 'New thread')

/** Its action at the top of the menu. */
export const actionLabel = (kind: Kind) =>
  kind === 'screenshot' ? 'Take a screenshot' : 'New thread'

const stored = (kind: Kind, settings: Settings) =>
  kind === 'screenshot' ? settings.captureShortcut : settings.newThreadShortcut

/** The one picked in the menu, else the default. */
export function chosen(kind: Kind, settings: Settings, platform = process.platform) {
  const offered = choices(kind, platform)
  const value = stored(kind, settings)
  return (offered.find((c) => c.id === value) ?? offered[0]!).id
}

export function remember(kind: Kind, value: string, settings: Settings) {
  if (kind === 'screenshot') settings.captureShortcut = value
  else settings.newThreadShortcut = value
}

/** `cmd+shift+2` as Electron writes it: `Command+Shift+2`. */
export function accelerator(id: string) {
  if (id === 'off') return undefined
  const keys: Record<string, string> = {
    cmd: 'Command',
    ctrl: 'Control',
    alt: 'Alt',
    shift: 'Shift',
    space: 'Space',
  }
  return id
    .split('+')
    .map((part) => keys[part] ?? part.toUpperCase())
    .join('+')
}

export const labelOf = (kind: Kind, id: string, platform = process.platform) =>
  choices(kind, platform).find((c) => c.id === id)?.label ?? id
