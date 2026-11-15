'use client'
// Brigade.app's dashboard window has no title bar on macOS and Windows (apps/desktop/src/windows.ts).
// On Windows, and on macOS while the page is too narrow for its sidebar, the app keeps a band
// above the page for the window's buttons: the page lays out as usual below it. On macOS
// otherwise the page fills the window: it keeps room for the traffic lights at the start of the
// sidebar's first row and marks what moves the window; `html[data-desktop-frame]` carries that
// for the styles (app/globals.css). Full screen hides the lights and takes it away. The band and
// Windows' buttons take the page's colors. Outside the app, and in older apps, nothing changes.
import { useSyncExternalStore } from 'react'
import { desktopBridge, type DesktopBridge } from './desktop-bridge'

export type DesktopFrame = 'mac'

/** Below this width the sidebar is a sheet (Tailwind's md): no first row for the lights. */
const NARROW = '(max-width: 47.999rem)'

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

/** The band above the page, and Windows' buttons, in the page's colors, again on each theme. */
function followTheme(frameApi: NonNullable<DesktopBridge['frame']>) {
  const send = () => {
    const style = getComputedStyle(document.body)
    const color = hex(style.backgroundColor)
    const symbolColor = hex(style.color)
    if (color && symbolColor) frameApi.setTitleBarColors({ color, symbolColor })
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
  if (app?.info.window !== 'main' || !app.frame) return
  const own = app.info.frame
  if (own === 'mac' || own === 'overlay') followTheme(app.frame)
  if (own !== 'mac') return
  const frameApi = app.frame
  const narrow = window.matchMedia(NARROW)
  let fullscreen = false
  const apply = () => {
    // Narrow: the app keeps a band above the page for the lights; the page lays out as usual.
    frameApi.setNarrow(narrow.matches)
    set(fullscreen || narrow.matches ? undefined : 'mac')
  }
  apply()
  narrow.addEventListener('change', apply)
  frameApi.onFullscreen((value) => {
    fullscreen = value
    apply()
  })
}

function subscribe(listener: () => void) {
  start()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 'mac' while the page itself keeps room for the traffic lights, else undefined. */
export function useDesktopFrame() {
  return useSyncExternalStore(
    subscribe,
    () => frame,
    () => undefined,
  )
}
