/**
 * Brigade.app's bridge, `window.brigadeDesktop` (apps/desktop/src/preload.ts): given only to the
 * dashboard's own pages in the app's windows, undefined anywhere else.
 */
export type DesktopBridge = {
  info: {
    window: 'main' | 'capture'
    platform: string
    version: string
    bridge: number
    /** The dashboard window's frame (apps/desktop/src/windows.ts); older apps leave it out. */
    frame?: 'mac' | 'overlay' | 'native'
    /** The computer's account's full name, for a guest's account; older apps leave it out. */
    userName?: string
  }
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
  frame?: {
    onFullscreen: (handle: (fullscreen: boolean) => void) => () => void
    setNarrow: (narrow: boolean) => void
    setTitleBarColors: (colors: { color: string; symbolColor: string }) => void
  }
  /** Whether the dashboard window has the keyboard, as the app says (undefined: not yet); older apps leave it out. */
  focus?: {
    focused: () => boolean | undefined
    onChange: (handle: (focused: boolean) => void) => () => void
  }
  /** Notifications the app shows itself (apps/desktop/src/notifications.ts); older apps leave it out. */
  notifications?: {
    status: () => Promise<{ on: boolean; supported: boolean }>
    enable: (device: { api: string; deviceId: string; token: string }) => Promise<void>
    /** The device it fetched for, which the API then forgets, if it was on. */
    disable: () => Promise<string | undefined>
  }
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
