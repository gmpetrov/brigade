// The bridge in the dashboard's pages, as window.brigadeDesktop: what Brigade.app does for them
// (apps/web/lib/brigade-app.ts uses it). Only on the dashboard's site, in Brigade's windows: the
// main side (ipc.ts) answers `info` with nothing anywhere else, and the bridge stays out.
import { contextBridge, ipcRenderer } from 'electron'

type Info = { window: 'main' | 'capture'; platform: string; version: string; bridge: number }

const info = ipcRenderer.sendSync('brigade:info') as Info | null

/** A listener for one of the app's events, and the function that removes it. */
function listen(channel: string, handle: (...args: unknown[]) => void) {
  const listener = (_event: unknown, ...args: unknown[]) => handle(...args)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

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
  })
