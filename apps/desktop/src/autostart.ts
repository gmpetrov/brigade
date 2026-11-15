// Open at login. On macOS, the same LaunchAgent the Tauri app wrote
// (~/Library/LaunchAgents/Brigade.plist, running Contents/MacOS/brigade-desktop), so a Mac that
// updated from it starts this app at login before it ever ran; on Linux, the same XDG autostart
// entry; on Windows, Electron's own login item.
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'

const NAME = 'Brigade'

const launchAgent = () => join(homedir(), 'Library', 'LaunchAgents', `${NAME}.plist`)
const xdgEntry = () =>
  join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'autostart', `${NAME}.desktop`)

/** What starts at login: this app's executable, or the AppImage file it runs from. */
function program() {
  if (process.platform === 'linux' && process.env.APPIMAGE) return process.env.APPIMAGE
  try {
    return realpathSync(process.execPath)
  } catch {
    return process.execPath
  }
}

const escapeXml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** As the auto-launch crate wrote it for the Tauri app. */
export const plist = (path: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${NAME}</string>
    <key>AssociatedBundleIdentifiers</key>
    <array></array>
    <key>ProgramArguments</key>
    <array><string>${escapeXml(path)}</string></array>
    <key>RunAtLoad</key>
    <true/>
  </dict>
</plist>`

export const desktopEntry = (path: string) => `[Desktop Entry]
Type=Application
Version=1.0
Name=${NAME}
Comment=${NAME} startup script
Exec="${path.replace(/(["`$\\])/g, '\\$1')}"
StartupNotify=false
Terminal=false
`

function read(path: string) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

export function isEnabled() {
  if (process.platform === 'darwin') return read(launchAgent()) !== undefined
  if (process.platform === 'linux') return read(xdgEntry()) !== undefined
  return app.getLoginItemSettings().openAtLogin
}

export function enable() {
  if (process.platform === 'darwin') {
    mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true })
    writeFileSync(launchAgent(), plist(program()))
  } else if (process.platform === 'linux') {
    mkdirSync(join(xdgEntry(), '..'), { recursive: true })
    writeFileSync(xdgEntry(), desktopEntry(program()))
  } else app.setLoginItemSettings({ openAtLogin: true, path: process.execPath })
}

export function disable() {
  if (process.platform === 'darwin') rmSync(launchAgent(), { force: true })
  else if (process.platform === 'linux') rmSync(xdgEntry(), { force: true })
  else app.setLoginItemSettings({ openAtLogin: false, path: process.execPath })
}

/** On launch: an entry that starts another copy (the app moved, an AppImage renamed) is
 * pointed at this one, when this one is installed for good. */
export function refresh(installed: boolean) {
  if (!installed || !isEnabled()) return
  const path = program()
  const current = process.platform === 'darwin' ? read(launchAgent()) : read(xdgEntry())
  if (current !== undefined && !current.includes(path)) enable()
}
