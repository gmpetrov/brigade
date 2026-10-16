'use client'
// Brigade.app (apps/desktop) shows /app/capture in its screenshot window and lets that
// page, and only on the dashboard's origin, call the draft's commands (capture.rs).
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'

type Internals = { __TAURI_INTERNALS__?: unknown }

/** Whether this page is in Brigade.app's screenshot window. */
export function inCaptureWindow() {
  if (typeof window === 'undefined' || !(window as Internals).__TAURI_INTERNALS__) return false
  try {
    return getCurrentWindow().label === 'capture'
  } catch {
    return false
  }
}

/** The draft's captures, by file name (their time in milliseconds), oldest first. */
export const captures = {
  list: () => invoke<string[]>('capture_list'),
  /** Its PNG bytes. To a page from a site, as this one, macOS's Tauri sends them as an array of numbers. */
  read: async (name: string) => {
    const bytes = await invoke<ArrayBuffer | number[]>('capture_read', { name })
    return bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : Uint8Array.from(bytes)
  },
  remove: (name: string) => invoke<void>('capture_remove', { name }),
  /** Sent: the draft starts over. */
  clear: () => invoke<void>('capture_clear'),
  /** Closes the window; the draft stays. */
  hide: () => invoke<void>('capture_hide'),
  /** A capture was added (its name), and the window came up for it. */
  onAdded: (handle: (name: string) => void) =>
    listen<string>('capture-added', (e) => handle(e.payload)),
  /** The window came up again, from the menu. */
  onShown: (handle: () => void) => listen('capture-shown', () => handle()),
}
