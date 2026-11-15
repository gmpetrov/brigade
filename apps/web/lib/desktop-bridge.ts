/**
 * Brigade.app's bridge, `window.brigadeDesktop` (apps/desktop/src/preload.ts): given only to the
 * dashboard's own pages in the app's windows, undefined anywhere else.
 */
export type DesktopBridge = {
  info: { window: 'main' | 'capture'; platform: string; version: string; bridge: number }
  captures: {
    list: () => Promise<string[]>
    read: (name: string) => Promise<Uint8Array>
    remove: (name: string) => Promise<void>
    clear: () => Promise<void>
    hide: () => Promise<void>
    onAdded: (handle: (name: string) => void) => () => void
    onShown: (handle: () => void) => () => void
  }
  signInWithBrowser: () => Promise<void>
  setBadge: (count: number) => void
  /** A provider's sign-in, done in the browser: its result comes back to the app. */
  providerSignIn: {
    /** A one-time value for the sign-in's return page, which only this app redeems. */
    start: () => Promise<string>
    onResult: (handle: (result: { connected?: string; error?: string }) => void) => () => void
  }
}

export const desktopBridge = (): DesktopBridge | undefined =>
  typeof window === 'undefined'
    ? undefined
    : (window as { brigadeDesktop?: DesktopBridge }).brigadeDesktop
