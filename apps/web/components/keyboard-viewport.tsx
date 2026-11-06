'use client'
// On a phone, the on-screen keyboard covers the page rather than shrinking it: Safari then
// pans the whole page up to keep the field in sight, hiding its header, and lets it scroll
// by the keyboard's height. While the keyboard is up, this gives the page the height left
// above it (`--viewport-h`, globals.css), so a page one screen tall (a thread, the new
// thread page) fits there and holds still instead.
import { useEffect } from 'react'

/** Less than this between the window and what shows of it is a browser bar, not a keyboard. */
const KEYBOARD_MIN = 120

export function KeyboardViewport() {
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    const root = document.documentElement
    let frame = 0
    const update = () => {
      frame = 0
      // Zoomed in by a pinch, what shows is smaller too, with no keyboard.
      const open = viewport.scale < 1.05 && window.innerHeight - viewport.height > KEYBOARD_MIN
      if (open) {
        root.style.setProperty('--viewport-h', `${Math.round(viewport.height)}px`)
        root.dataset.keyboard = ''
      } else if (root.dataset.keyboard !== undefined) {
        root.style.removeProperty('--viewport-h')
        delete root.dataset.keyboard
      }
      // A page that does not scroll (globals.css) goes back to its top, where it now fits:
      // Safari panned it up as the keyboard rose, and may leave it so once it is down.
      if (getComputedStyle(root).overflowY === 'hidden' && window.scrollY !== 0) {
        window.scrollTo(0, 0)
      }
    }
    // Once a frame: the keyboard's slide sends many.
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    viewport.addEventListener('resize', schedule)
    viewport.addEventListener('scroll', schedule)
    return () => {
      cancelAnimationFrame(frame)
      viewport.removeEventListener('resize', schedule)
      viewport.removeEventListener('scroll', schedule)
      root.style.removeProperty('--viewport-h')
      delete root.dataset.keyboard
    }
  }, [])
  return null
}
