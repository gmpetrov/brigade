'use client'
// Brigade.app's dashboard window has no title bar on macOS and Windows (apps/desktop/src/windows.ts).
// The page makes room for the window's buttons and marks what moves the window: on macOS the
// traffic lights sit at the start of the sidebar's first row; on Windows the system's buttons
// sit over the top right, above a band the page leaves empty. `html[data-desktop-frame]`
// carries the frame for the styles (app/globals.css); full screen, which hides the traffic
// lights, takes it away. Outside the app, and in older apps, nothing changes.
import { useSyncExternalStore } from 'react'
import { desktopBridge } from './desktop-bridge'

export type DesktopFrame = 'mac' | 'overlay'

let frame: DesktopFrame | undefined
let started = false
const listeners = new Set<() => void>()

function set(next: DesktopFrame | undefined) {
  if (next === frame) return
  frame = next
  if (next) document.documentElement.dataset.desktopFrame = next
  else delete document.documentElement.dataset.desktopFrame
  for (const listener of listeners) listener()
}

/** Hex of a CSS color as the page draws it (oklch included), through a 1px canvas. */
function hex(color: string) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return undefined
  context.fillStyle = color
  context.fillRect(0, 0, 1, 1)
  const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`
}

/** Windows draws its buttons in the page's background and text colors, again on each theme. */
function followTheme(setColors: (colors: { color: string; symbolColor: string }) => void) {
  const send = () => {
    const style = getComputedStyle(document.body)
    const color = hex(style.backgroundColor)
    const symbolColor = hex(style.color)
    if (color && symbolColor) setColors({ color, symbolColor })
  }
  send()
  new MutationObserver(send).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style'],
  })
}

function start() {
  if (started) return
  started = true
  const app = desktopBridge()
  const own = app?.info.window === 'main' ? app.info.frame : undefined
  if (own !== 'mac' && own !== 'overlay') return
  set(own)
  // A bridge from before full screen events: the room stays kept.
  app?.frame?.onFullscreen((fullscreen) => set(fullscreen ? undefined : own))
  if (own === 'overlay' && app?.frame) followTheme(app.frame.setTitleBarColors)
}

function subscribe(listener: () => void) {
  start()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The window's frame when Brigade.app shows this page without a title bar, else undefined. */
export function useDesktopFrame() {
  return useSyncExternalStore(
    subscribe,
    () => frame,
    () => undefined,
  )
}
