/**
 * Brigade.app's bridge, `window.brigadeDesktop` (apps/desktop/src/preload.ts): given only to the
 * dashboard's own pages in the app's windows, undefined anywhere else.
 */
/** A library app installed on this computer (apps/desktop/src/installed-apps.ts). */
export type InstalledDesktopApp = {
  /** Its `index.html` document id. */
  appId: string
  path: string
  /** The name its icon shows. */
  name: string
  workspaceId: string
  workspaceName: string
}

export type DesktopBridge = {
  info: {
    /** `app`: an installed app's window, whose bridge has `info` and `apps.setBadge` only. */
    window: 'main' | 'capture' | 'app'
    platform: string
    version: string
    bridge: number
    /** The dashboard window's frame (apps/desktop/src/windows.ts); older apps leave it out. */
    frame?: 'mac' | 'overlay' | 'native'
    /** The computer's account's full name, for a guest's account; older apps leave it out. */
    userName?: string
    /** The workspace this computer already runs teammates for (docs/guests.md); older apps leave it out. */
    linked?: string
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
  /** The workspace this computer runs now, or `linking` while a link is asked about or installs (docs/guests.md); older apps leave it out. */
  computer?: () => Promise<{ linked?: string; linking: boolean }>
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
  /** Library apps installed on this computer, each in a window of its own; older apps leave it out. */
  apps?: {
    installed: () => Promise<InstalledDesktopApp[]>
    /** Brigade.app asks the person first: null when they said no. */
    install: (input: {
      appId: string
      path: string
      title: string
      iconPng: Uint8Array
      workspaceId: string
      workspaceName: string
      /** The app's pane in the page, where the install animation starts; older apps ignore it. */
      from?: { x: number; y: number; width: number; height: number }
    }) => Promise<InstalledDesktopApp | null>
    open: (appId: string) => Promise<void>
    /** Brigade.app asks the person first: whether it was uninstalled. */
    uninstall: (appId: string) => Promise<boolean>
    onChanged: (handle: (apps: InstalledDesktopApp[]) => void) => () => void
  }
  /** A provider's sign-in, done in the browser: its result comes back to the app. */
  providerSignIn: {
    /** A one-time value for the sign-in's return page, which only this app redeems. */
    start: () => Promise<string>
    onResult: (handle: (result: { connected?: string; error?: string }) => void) => () => void
  }
}

const raw = () =>
  typeof window === 'undefined'
    ? undefined
    : (window as { brigadeDesktop?: DesktopBridge | AppWindowBridge }).brigadeDesktop

/**
 * The bridge of the dashboard window or the new thread window. An installed app's window has a
 * bridge of its own (`appWindowBridge`): there the dashboard acts as in a browser.
 */
export const desktopBridge = (): DesktopBridge | undefined => {
  const bridge = raw()
  return bridge && bridge.info?.window !== 'app' ? (bridge as DesktopBridge) : undefined
}

/** In an installed app's window (apps/desktop/src/app-windows.ts): only what that window needs. */
export type AppWindowBridge = {
  info: { window: 'app'; platform: string; version: string; bridge: number }
  apps: {
    setBadge: (count: number) => void
    /** Uninstalls this window's app, after Brigade.app asks; older apps leave it out. */
    uninstall?: () => Promise<boolean>
  }
}

export const appWindowBridge = (): AppWindowBridge | undefined => {
  const bridge = raw()
  return bridge?.info?.window === 'app' ? (bridge as AppWindowBridge) : undefined
}
