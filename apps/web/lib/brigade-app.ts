'use client'
// Brigade.app (apps/desktop) shows the dashboard in its windows: the dashboard itself, and
// /app/capture in its new thread window. Its pages, and only on the dashboard's site, reach the
// app through a bridge. Brigade.app is an Electron app, whose preload gives the bridge as
// window.brigadeDesktop; the Tauri app before it, still installed until it updates, showed only
// the new thread window and took Tauri commands (its capture.rs).
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { MouseEvent } from 'react'
import { desktopBridge } from '@/lib/desktop-bridge'

type Internals = { __TAURI_INTERNALS__?: unknown }

const bridge = desktopBridge

const tauri = () => typeof window !== 'undefined' && !!(window as Internals).__TAURI_INTERNALS__

const CONTROLS = 'a, button, input, select, textarea, label, [role], [contenteditable="true"]'

/** Whether this page is in one of Brigade.app's windows. */
export const inDesktopApp = () => !!bridge() || inCaptureWindow()

/** Whether this page is in Brigade.app's new thread window. */
export function inCaptureWindow() {
  const app = bridge()
  if (app) return app.info.window === 'capture'
  if (!tauri()) return false
  try {
    return getCurrentWindow().label === 'capture'
  } catch {
    return false
  }
}

/** The app's platform (`darwin`, `win32`, `linux`); the Tauri app ran on macOS only. */
export const desktopPlatform = () => bridge()?.info.platform ?? (tauri() ? 'darwin' : undefined)

/** The draft's captures, by file name (their time in milliseconds), oldest first. */
export const captures = {
  list: () => bridge()?.captures.list() ?? invoke<string[]>('capture_list'),
  /** Its PNG bytes. To a page from a site, as this one, macOS's Tauri sends them as an array of numbers. */
  read: async (name: string) => {
    const app = bridge()
    if (app) return new Uint8Array(await app.captures.read(name))
    const bytes = await invoke<ArrayBuffer | number[]>('capture_read', { name })
    return bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : Uint8Array.from(bytes)
  },
  remove: (name: string) =>
    bridge()?.captures.remove(name) ?? invoke<void>('capture_remove', { name }),
  /** Sent: the draft starts over. */
  clear: () => bridge()?.captures.clear() ?? invoke<void>('capture_clear'),
  /** Closes the window; the draft stays. */
  hide: () => bridge()?.captures.hide() ?? invoke<void>('capture_hide'),
  /** A capture was added (its name), and the window came up for it. */
  onAdded: (handle: (name: string) => void) => {
    const app = bridge()
    if (app) return Promise.resolve(app.captures.onAdded(handle))
    return listen<string>('capture-added', (e) => handle(e.payload))
  },
  /**
   * A press on the window's top row: the window follows the mouse until it is released, unless
   * the press is on a control in the row. The Tauri app moved it itself (its drag.rs): Tauri's
   * own drag does nothing on macOS 27. Electron's window moves by the row's CSS
   * (`data-window-drag`, apps/desktop/src/capture.ts): nothing to do here.
   */
  drag: (e: MouseEvent<HTMLElement>) => {
    if (bridge() || !tauri()) return
    if (e.button !== 0 || e.detail !== 1) return
    const control = (e.target as Element).closest(CONTROLS)
    if (control && e.currentTarget.contains(control)) return
    e.preventDefault()
    invoke<void>('capture_drag').catch(() => getCurrentWindow().startDragging())
  },
  /** The window came up again, from the menu. */
  onShown: (handle: () => void) => {
    const app = bridge()
    if (app) return Promise.resolve(app.captures.onShown(handle))
    return listen('capture-shown', () => handle())
  },
}

/**
 * The browser's page that signs the window in (src/desktop-sign-in.ts in the API): the
 * window opens it, with ?challenge=, and gets the code back as brigade://sign-in?code=….
 */
export const DESKTOP_SIGN_IN = '/app/desktop-sign-in'

/** An installed app's window (apps/desktop/src/app-windows.ts): the app alone. */
export const APP_WINDOW = '/app/apps/window'

/** Opens the browser to sign the window in; the app then brings it back to /sign-in with the code. */
export const signInWithBrowser = () =>
  bridge()?.signInWithBrowser() ?? invoke<void>('capture_sign_in')

/** What needs the member, on the app's icon (the Dock's on macOS), in the dashboard window. */
export function setDesktopBadge(count: number) {
  const app = bridge()
  if (app?.info.window === 'main') app.setBadge(count)
}
