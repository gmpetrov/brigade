'use client'

import { useEffect, useRef } from 'react'
import { c } from './parts'

const random = (min: number, max: number) => min + Math.random() * (max - min)
const rad = (deg: number) => (deg * Math.PI) / 180

// The face is drawn on a sphere seen from the front: R is its radius in the drawing's units,
// and each eye sits at an angle from its middle. Turning the head moves each eye along the
// sphere, so the far one slides less and narrows more than the near one.
const R = 48
const EYES = [-9.5, 9.5].map((x) => Math.asin(x / R))
const SHAPE = 'M56 0A44 56 0 0 1 100 56A40 44 0 0 1 60 100A60 54 0 0 1 0 46A56 46 0 0 1 56 0Z'

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
        const yaw = rad(random(-38, 38))
        const pitch = rad(random(-22, 16))
        EYES.forEach((eye, i) => {
          set(`--e${i}x`, `${R * (Math.sin(eye + yaw) - Math.sin(eye))}px`)
          set(`--e${i}s`, `${Math.cos(eye + yaw) / Math.cos(eye)}`)
        })
        set('--ey', `${R * Math.sin(pitch) * 0.7}px`)
        set('--esq', `${Math.cos(pitch)}`)
        // The light stays put while the surface turns under it.
        set('--hx', `${-R * Math.sin(yaw) * 0.5}px`)
        set('--hy', `${-R * Math.sin(pitch) * 0.5}px`)
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
        <defs>
          <clipPath id="pb-shape">
            <path d={SHAPE} />
          </clipPath>
          <radialGradient id="pb-light">
            <stop offset="0" className={c('pb-light-in')} />
            <stop offset="1" className={c('pb-light-out')} />
          </radialGradient>
        </defs>
        <g className={c('pb-body')}>
          <path d={SHAPE} />
          <g clipPath="url(#pb-shape)">
            <circle className={c('pb-light')} cx="36" cy="30" r="46" fill="url(#pb-light)" />
          </g>
          {[
            { cls: 'pb-eye e0', d: 'M34.5 44Q40.5 28 46.5 44' },
            { cls: 'pb-eye e1', d: 'M53.5 44Q59.5 28 65.5 44' },
          ].map((eye) => (
            <g key={eye.cls} className={c(eye.cls)}>
              <path className={c('pb-lid')} d={eye.d} />
            </g>
          ))}
        </g>
      </svg>
    </div>
  )
}
