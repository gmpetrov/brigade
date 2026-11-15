// The bridge's main side: what the dashboard's pages in Brigade's windows may ask (preload.ts).
// Each request is checked: from a window of Brigade's, from its top frame, on the dashboard's
// site; the draft's captures only from the new thread window.
import { app, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import * as capture from './capture.js'
import { onDashboard } from './settings.js'
import { kindOf, type WindowKind } from './windows.js'

/** The bridge's version: the dashboard checks it before using what came later. */
export const BRIDGE_VERSION = 1

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

  // What needs the member, on the Dock icon (macOS) or the launcher's (Linux).
  ipcMain.on('brigade:badge', (event, count: unknown) => {
    if (from(event) !== 'main') return
    const n = Number(count)
    app.setBadgeCount(Number.isInteger(n) && n > 0 ? n : 0)
  })
}
