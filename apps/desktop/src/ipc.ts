// The bridge's main side: what the dashboard's pages in Brigade's windows may ask (preload.ts).
// Each request is checked: from a window of Brigade's, from its top frame, on the dashboard's
// site; the draft's captures only from the new thread window.
import { app, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import * as capture from './capture.js'
import { closeFind, findAgain, openFind } from './find.js'
import * as notifications from './notifications.js'
import { startProviderSignIn } from './provider-sign-in.js'
import { onDashboard } from './settings.js'
import { accountFullName } from './system-name.js'
import { activeLink } from './workspaces.js'
import { ctx } from './context.js'
import { linkInProgress } from './links.js'
import { dashboardFrame, kindOf, setFrameColors, setNarrow, type WindowKind } from './windows.js'

/** The bridge's version: the dashboard checks it before using what came later. */
export const BRIDGE_VERSION = 3

/** The kind of Brigade window a request comes from, from its top frame on the dashboard's site. */
function senderKind(event: IpcMainEvent | IpcMainInvokeEvent): WindowKind | undefined {
  const frame = event.senderFrame
  if (!frame || frame !== event.sender.mainFrame || !onDashboard(frame.url)) return undefined
  return kindOf(event.sender)
}

/**
 * The dashboard or new thread window a request comes from. An installed app's window
 * (app-windows.ts) gets none of this: only `info`, and its badge there.
 */
function from(event: IpcMainEvent | IpcMainInvokeEvent): Exclude<WindowKind, 'app'> | undefined {
  const kind = senderKind(event)
  return kind === 'app' ? undefined : kind
}

/** `linked`: the name of the workspace the runner runs for, when there is one. */
function linkedName(): { linked?: string } {
  try {
    const name = activeLink()?.name
    return name ? { linked: name } : {}
  } catch {
    return {}
  }
}

/** Whether this computer is taken, asked when it matters: `info` is read once, as a page
 * loads, and a link still installing has no workspace in it yet. */
function computerState() {
  let installing = false
  try {
    installing = ctx.supervisor.status.kind === 'installing'
  } catch {}
  return { ...linkedName(), linking: linkInProgress() || installing }
}

export function registerBridge() {
  // Read once, early: a page asks for `info` as it loads, and waits for nothing.
  let userName: string | null = null
  void accountFullName()
    .then((name) => (userName = name))
    .catch(() => {})
  ipcMain.on('brigade:info', (event) => {
    if (senderKind(event) === 'app') {
      event.returnValue = {
        window: 'app',
        platform: process.platform,
        version: app.getVersion(),
        bridge: BRIDGE_VERSION,
      }
      return
    }
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
          // The computer's account's full name, for a guest's account (docs/guests.md).
          ...(kind === 'main' && userName && { userName }),
          // The workspace this computer already runs teammates for, read now (a link changes
          // it): the window then signs in to it rather than starting a guest (docs/guests.md).
          ...(kind === 'main' && linkedName()),
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

  // The workspace this computer runs, or one being linked now (docs/guests.md).
  ipcMain.handle('brigade:computer', (event) => {
    if (from(event) !== 'main') throw new Error('Not allowed.')
    return computerState()
  })

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
    else if (what === 'close') closeFind()
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
