// The bridge in the dashboard's pages, as window.brigadeDesktop: what Brigade.app does for them
// (apps/web/lib/brigade-app.ts uses it). Only on the dashboard's site, in Brigade's windows: the
// main side (ipc.ts) answers `info` with nothing anywhere else, and the bridge stays out.
import { contextBridge, ipcRenderer } from 'electron'

type Info = {
  window: 'main' | 'capture'
  platform: string
  version: string
  bridge: number
  /** The dashboard window's frame: 'mac' (no title bar), 'overlay' (Windows), 'native'. */
  frame?: 'mac' | 'overlay' | 'native'
}

const info = ipcRenderer.sendSync('brigade:info') as Info | null

/** A listener for one of the app's events, and the function that removes it. */
function listen(channel: string, handle: (...args: unknown[]) => void) {
  const listener = (_event: unknown, ...args: unknown[]) => handle(...args)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

/** Whether the dashboard window has the keyboard, as the app says; unknown until it does. */
let focused: boolean | undefined
if (info?.window === 'main')
  ipcRenderer.on('brigade:window-focus', (_event, value: unknown) => {
    focused = value === true
  })

// ⌘F (Ctrl+F on Windows and Linux) finds in the page, with the app's find bar (find.ts), unless
// the page used the key itself (a code editor's own search). ⌘G and ⇧⌘G (F3) for the next and
// previous match.
if (info?.window === 'main')
  window.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.altKey) return
    const mod = info.platform === 'darwin' ? event.metaKey : event.ctrlKey
    const key = event.key.toLowerCase()
    let what: 'open' | 'next' | 'previous'
    if (mod && key === 'f' && !event.shiftKey) what = 'open'
    else if ((mod && key === 'g') || event.key === 'F3') what = event.shiftKey ? 'previous' : 'next'
    else return
    event.preventDefault()
    ipcRenderer.send('brigade:find', what)
  })

if (info)
  contextBridge.exposeInMainWorld('brigadeDesktop', {
    info,
    captures: {
      list: () => ipcRenderer.invoke('brigade:captures:list'),
      read: (name: string) => ipcRenderer.invoke('brigade:captures:read', name),
      remove: (name: string) => ipcRenderer.invoke('brigade:captures:remove', name),
      clear: () => ipcRenderer.invoke('brigade:captures:clear'),
      hide: () => ipcRenderer.invoke('brigade:window:hide'),
      onAdded: (handle: (name: string) => void) =>
        listen('brigade:capture-added', (name) => handle(String(name))),
      onShown: (handle: () => void) => listen('brigade:capture-shown', () => handle()),
    },
    signInWithBrowser: () => ipcRenderer.invoke('brigade:sign-in'),
    setBadge: (count: number) => ipcRenderer.send('brigade:badge', count),
    frame: {
      /** The window went full screen (macOS hides the traffic lights) or came back. */
      onFullscreen: (handle: (fullscreen: boolean) => void) =>
        listen('brigade:fullscreen', (fullscreen) => handle(fullscreen === true)),
      /** macOS: the page is too narrow for its sidebar, so the traffic lights need a band above it. */
      setNarrow: (narrow: boolean) => ipcRenderer.send('brigade:narrow', narrow),
      /** The band above the page, and Windows' buttons, in the page's colors, as #rrggbb. */
      setTitleBarColors: (colors: { color: string; symbolColor: string }) =>
        ipcRenderer.send('brigade:title-bar-colors', colors),
    },
    /** The dashboard window has the keyboard (the app in front): its notifications wait. */
    focus: {
      focused: () => focused,
      onChange: (handle: (focused: boolean) => void) =>
        listen('brigade:window-focus', (value) => handle(value === true)),
    },
    /** Notifications the app shows itself (apps/desktop/src/notifications.ts). */
    notifications: {
      status: () => ipcRenderer.invoke('brigade:notifications:status'),
      enable: (device: { api: string; deviceId: string; token: string }) =>
        ipcRenderer.invoke('brigade:notifications:enable', device),
      disable: () => ipcRenderer.invoke('brigade:notifications:disable'),
    },
    providerSignIn: {
      start: () => ipcRenderer.invoke('brigade:provider-sign-in:start'),
      onResult: (handle: (result: { connected?: string; error?: string }) => void) =>
        listen('brigade:provider-signed-in', (result) =>
          handle(result as { connected?: string; error?: string }),
        ),
    },
  })
