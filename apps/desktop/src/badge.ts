// Brigade's badge, what needs the member: on the Dock icon (macOS), the launcher's (Linux) and
// Brigade's taskbar button (Windows). On Windows, Electron draws it on every window's button
// (Browser::SetBadgeCount in shell/browser/browser_win.cc loops over them all), so an installed
// app's own button (app-windows.ts) showed Brigade's count too: theirs is taken off again. The
// dashboard sets it through the bridge only, not the Badging API too (navigator.setAppBadge, the
// same call in Electron), in apps/web/components/notifications.tsx.
import { app, type BrowserWindow } from 'electron'

let ownButtons: () => BrowserWindow[] = () => []

/** The windows with a taskbar button of their own, which never show Brigade's badge. */
export function keepOff(windows: () => BrowserWindow[]) {
  ownButtons = windows
}

export function setBadge(count: number) {
  app.setBadgeCount(count)
  if (process.platform !== 'win32') return
  for (const window of ownButtons()) if (!window.isDestroyed()) window.setOverlayIcon(null, '')
}
