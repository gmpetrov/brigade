// The bridge's main side: what the dashboard's pages in Brigade's windows may ask (preload.ts).
// Each request is checked: from a window of Brigade's, from its top frame, on the dashboard's
// site; the draft's captures only from the new thread window.
import { app, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import * as capture from './capture.js'
import { findAgain, openFind } from './find.js'
import * as notifications from './notifications.js'
import { startProviderSignIn } from './provider-sign-in.js'
import { onDashboard } from './settings.js'
import { dashboardFrame, kindOf, setFrameColors, setNarrow, type WindowKind } from './windows.js'

/** The bridge's version: the dashboard checks it before using what came later. */
export const BRIDGE_VERSION = 2

function from(event: IpcMainEvent | IpcMainInvokeEvent): WindowKind | undefined {
  const frame = event.senderFrame
  if (!frame || frame !== event.sender.mainFrame || !onDashboard(frame.url)) return undefined
  return kindOf(event.sender)
}

export function registerBridge() {
  ipcMain.on('brigade:info', (event) => {
    const kind = from(event)
    event.returnValue = kind
      ? {
          window: kind,
          platform: process.platform,
          // Only the dashboard window goes without a title bar (the new thread window has its
          // own way, capture.ts).
          ...(kind === 'main' && { frame: dashboardFrame() }),
          version: app.getVersion(),
          bridge: BRIDGE_VERSION,
        }
      : null
  })

  const captureOnly =
    <A extends unknown[], R>(handle: (...args: A) => R) =>
    (event: IpcMainInvokeEvent, ...args: A) => {
      if (from(event) !== 'capture') throw new Error('Not allowed.')
      return handle(...args)
    }
  ipcMain.handle(
    'brigade:captures:list',
    captureOnly(() => capture.names()),
  )
  ipcMain.handle(
    'brigade:captures:read',
    captureOnly((name: unknown) => capture.read(String(name))),
  )
  ipcMain.handle(
    'brigade:captures:remove',
    captureOnly((name: unknown) => capture.remove(String(name))),
  )
  ipcMain.handle(
    'brigade:captures:clear',
    captureOnly(() => capture.clear()),
  )
  ipcMain.handle(
    'brigade:window:hide',
    captureOnly(() => capture.hide()),
  )

  ipcMain.handle('brigade:sign-in', async (event) => {
    const kind = from(event)
    if (!kind) throw new Error('Not allowed.')
    await capture.startSignIn(kind)
  })

  ipcMain.handle('brigade:provider-sign-in:start', (event) => {
    if (!from(event)) throw new Error('Not allowed.')
    return startProviderSignIn()
  })

  // The band above the dashboard, and Windows' buttons, in the page's colors, as its theme changes.
  ipcMain.on('brigade:title-bar-colors', (event, colors: unknown) => {
    if (from(event) !== 'main' || !colors || typeof colors !== 'object') return
    const { color, symbolColor } = colors as Record<string, unknown>
    const hex = (value: unknown): value is string =>
      typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
    if (hex(color) && hex(symbolColor)) setFrameColors({ color, symbolColor })
  })

  // ⌘F in the dashboard's page, which left it alone (preload.ts): the find bar (find.ts).
  ipcMain.on('brigade:find', (event, what: unknown) => {
    if (from(event) !== 'main') return
    if (what === 'open') void openFind()
    else if (what === 'next' || what === 'previous') void findAgain(what === 'next')
  })

  // macOS: the page has no room for the traffic lights (too narrow for its sidebar).
  ipcMain.on('brigade:narrow', (event, value: unknown) => {
    if (from(event) === 'main') setNarrow(value === true)
  })

  // Notifications shown by the app itself (notifications.ts), turned on and off in the
  // dashboard's Settings > Notifications, and off when the person signs out.
  ipcMain.handle('brigade:notifications:status', (event) => {
    if (!from(event)) throw new Error('Not allowed.')
    return { on: !!notifications.device(), supported: notifications.supported() }
  })
  ipcMain.handle('brigade:notifications:enable', (event, input: unknown) => {
    if (!from(event)) throw new Error('Not allowed.')
    const { api, deviceId, token } = (input ?? {}) as Record<string, unknown>
    if (typeof api !== 'string' || typeof deviceId !== 'string' || typeof token !== 'string')
      throw new Error('A device is needed.')
    if (!deviceId || deviceId.length > 100 || !token || token.length > 200)
      throw new Error('A device is needed.')
    notifications.enable({ api, deviceId, token })
  })
  ipcMain.handle('brigade:notifications:disable', (event) => {
    if (!from(event)) throw new Error('Not allowed.')
    return notifications.disable()
  })

  // What needs the member, on the Dock icon (macOS) or the launcher's (Linux).
  ipcMain.on('brigade:badge', (event, count: unknown) => {
    if (from(event) !== 'main') return
    const n = Number(count)
    app.setBadgeCount(Number.isInteger(n) && n > 0 ? n : 0)
  })
}
