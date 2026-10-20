'use client'

import { useEffect } from 'react'

/** Pauses the looping animations of a section (marked `data-anim`) while it is off screen,
 * with one IntersectionObserver for the page. It only ever adds `data-offscreen`, so before
 * it runs, and without JavaScript, every section plays: nothing waits on it to appear. */
export function PauseOffscreen() {
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          entry.target.toggleAttribute('data-offscreen', !entry.isIntersecting)
      },
      { rootMargin: '200px 0px' },
    )
    for (const el of document.querySelectorAll('[data-anim]')) observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return null
}
