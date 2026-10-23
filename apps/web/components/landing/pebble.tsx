'use client'

import { useEffect, useRef } from 'react'
import { c } from './parts'

const random = (min: number, max: number) => min + Math.random() * (max - min)

/**
 * Brigade's pebble, large, in the page's ink. It has no loop: its eyes dart to a random
 * point, hold it for a random while, squash as they look aside and blink now and then, while
 * the body drifts slowly. Each move only sets CSS variables that transitions ease. It keeps
 * still under reduced motion and while it is off screen.
 */
export function Pebble() {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let visible = false
    const timers: number[] = []
    const later = (fn: () => void, ms: number) => timers.push(window.setTimeout(fn, ms))
    const set = (name: string, value: string) => el.style.setProperty(name, value)

    const look = () => {
      if (visible) {
        const x = random(-9, 9)
        const y = random(-6, 5)
        set('--ex', `${x}px`)
        set('--ey', `${y}px`)
        // Eyes looking aside narrow, as a face turning would show them.
        set('--esx', `${1 - Math.abs(x) / 30}`)
        if (Math.random() < 0.22) blink(Math.random() < 0.3)
      }
      later(look, Math.random() < 0.3 ? random(150, 450) : random(700, 3200))
    }
    const blink = (twice: boolean) => {
      set('--esy', '0.08')
      later(() => set('--esy', '1'), 130)
      if (twice) {
        later(() => set('--esy', '0.08'), 260)
        later(() => set('--esy', '1'), 390)
      }
    }
    const drift = () => {
      if (visible) {
        set('--bx', `${random(-3, 3)}%`)
        set('--by', `${random(-3, 3)}%`)
        set('--br', `${random(-6, 6)}deg`)
      }
      later(drift, random(2500, 5000))
    }

    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false
    })
    observer.observe(el)
    // Once the observer has said whether it shows.
    later(look, 300)
    later(drift, 300)
    return () => {
      observer.disconnect()
      timers.forEach(clearTimeout)
    }
  }, [])

  return (
    <div ref={ref} className={c('art pebble')} aria-hidden="true">
      <svg viewBox="0 0 100 100">
        <g className={c('pb-body')}>
          <path d="M56 0A44 56 0 0 1 100 56A40 44 0 0 1 60 100A60 54 0 0 1 0 46A56 46 0 0 1 56 0Z" />
          <g className={c('pb-look')}>
            <g className={c('pb-eyes')}>
              <path d="M34.5 44Q40.5 28 46.5 44" />
              <path d="M53.5 44Q59.5 28 65.5 44" />
            </g>
          </g>
        </g>
      </svg>
    </div>
  )
}
