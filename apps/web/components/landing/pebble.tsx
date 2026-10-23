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
// Its moods, as each eye's smile (1: the logo's happy arcs, 0: open) and how tall it opens.
const MOODS: { weight: number; eyes: [smile: number, open: number][] }[] = [
  {
    weight: 40,
    eyes: [
      [0, 1],
      [0, 1],
    ],
  }, // open
  {
    weight: 30,
    eyes: [
      [1, 1],
      [1, 1],
    ],
  }, // smiling
  {
    weight: 10,
    eyes: [
      [0, 1.35],
      [0, 1.35],
    ],
  }, // wide open
  {
    weight: 8,
    eyes: [
      [0, 0.45],
      [0, 0.45],
    ],
  }, // squinting
]
const pickMood = () => {
  let n = random(
    0,
    MOODS.reduce((sum, m) => sum + m.weight, 0),
  )
  return MOODS.find((m) => (n -= m.weight) < 0) ?? MOODS[0]!
}

const SHAPE = 'M56 0A44 56 0 0 1 100 56A40 44 0 0 1 60 100A60 54 0 0 1 0 46A56 46 0 0 1 56 0Z'

/**
 * Brigade's pebble, large, in the page's ink, reacting to the visitor. Its eyes follow the
 * pointer, turning its head in 3D (eyes on a sphere, a light sliding the other way); it
 * smiles while the pointer is on Sign up; it dozes off when nobody moves and wakes with a
 * start. Left alone it looks around at random, changes mood and blinks, with no loop. Each
 * move only sets CSS variables that transitions ease. It keeps still under reduced motion.
 */

// How long without a move of the visitor before it dozes off, and how long its eyes keep
// following the pointer after it stopped.
const SLEEP_AFTER = 9000
const POINTER_HOLD = 2500

export function Pebble() {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let visible = false
    let asleep = false
    let hovering = false
    let lastPointer = 0
    let lastActivity = performance.now()
    const timers: number[] = []
    const later = (fn: () => void, ms: number) => timers.push(window.setTimeout(fn, ms))
    const set = (name: string, value: string) => el.style.setProperty(name, value)
    const setEyes = (smile: number, open: number) =>
      [0, 1].forEach((i) => {
        set(`--h${i}`, `${smile}`)
        set(`--o${i}`, `${open}`)
      })

    // Turns the head: yaw and pitch in radians.
    const turn = (yaw: number, pitch: number) => {
      EYES.forEach((eye, i) => {
        set(`--e${i}x`, `${R * (Math.sin(eye + yaw) - Math.sin(eye))}px`)
        set(`--e${i}s`, `${Math.cos(eye + yaw) / Math.cos(eye)}`)
      })
      set('--ey', `${R * Math.sin(pitch) * 0.7}px`)
      set('--esq', `${Math.cos(pitch)}`)
      // The light stays put while the surface turns under it.
      set('--hx', `${-R * Math.sin(yaw) * 0.5}px`)
      set('--hy', `${-R * Math.sin(pitch) * 0.5}px`)
    }
    // Looks at a point of the page, as far as a head turns.
    const lookAt = (x: number, y: number) => {
      const box = el.getBoundingClientRect()
      const dx = x - (box.left + box.width * 0.5)
      const dy = y - (box.top + box.height * 0.42)
      turn(rad(Math.max(-40, Math.min(40, dx / 14))), rad(Math.max(-24, Math.min(18, dy / 14))))
    }

    const blink = (twice: boolean) => {
      set('--esy', '0.08')
      later(() => set('--esy', '1'), 130)
      if (twice) {
        later(() => set('--esy', '0.08'), 260)
        later(() => set('--esy', '1'), 390)
      }
    }

    // On its own: looks somewhere at random, holds it for a random while.
    const look = () => {
      const now = performance.now()
      if (visible && !asleep && now - lastPointer > POINTER_HOLD) {
        delete el.dataset.follow
        turn(rad(random(-38, 38)), rad(random(-22, 16)))
        if (Math.random() < 0.22) blink(Math.random() < 0.3)
      }
      later(look, Math.random() < 0.3 ? random(150, 450) : random(700, 3200))
    }
    const drift = () => {
      if (visible) {
        set('--bx', `${random(-3, 3)}%`)
        set('--by', `${random(-3, 3)}%`)
        set('--br', `${random(-6, 6)}deg`)
      }
      later(drift, random(2500, 5000))
    }
    const mood = () => {
      if (visible && !asleep && !hovering) {
        const [left] = pickMood().eyes
        if (left) setEyes(...left)
      }
      // A mood lasts a while, never the same length.
      later(mood, random(1800, 6500))
    }

    // Nobody moved for a while: the eyes close slowly and the head drops.
    const doze = () => {
      if (!asleep && visible && performance.now() - lastActivity > SLEEP_AFTER) {
        asleep = true
        el.dataset.asleep = ''
        turn(0, rad(16))
        setEyes(0, 0.06)
      }
      later(doze, 1000)
    }
    // Any move wakes it with a start: eyes wide open and a little hop.
    const wake = () => {
      lastActivity = performance.now()
      if (!asleep) return
      asleep = false
      delete el.dataset.asleep
      setEyes(0, 1.35)
      set('--hop', '-4%')
      later(() => set('--hop', '0%'), 180)
      later(() => setEyes(0, 1), 900)
    }

    // Following the pointer: once a frame, with short transitions (data-follow), since a
    // long eased one restarted at each move lags behind it.
    let frame = 0
    let pointer = { x: 0, y: 0 }
    const onPointer = (e: PointerEvent) => {
      wake()
      lastPointer = performance.now()
      pointer = { x: e.clientX, y: e.clientY }
      if (!visible || frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        el.dataset.follow = ''
        lookAt(pointer.x, pointer.y)
      })
    }
    const button = el.closest('section')?.querySelector('a')
    const onEnter = () => {
      hovering = true
      setEyes(1, 1)
    }
    const onLeave = () => {
      hovering = false
      setEyes(0, 1)
    }

    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false
    })
    observer.observe(el)
    window.addEventListener('pointermove', onPointer, { passive: true })
    window.addEventListener('scroll', wake, { passive: true })
    window.addEventListener('keydown', wake)
    button?.addEventListener('pointerenter', onEnter)
    button?.addEventListener('pointerleave', onLeave)
    // Once the observer has said whether it shows.
    later(look, 300)
    later(drift, 300)
    later(mood, random(1500, 3000))
    later(doze, 1000)
    return () => {
      observer.disconnect()
      window.removeEventListener('pointermove', onPointer)
      window.removeEventListener('scroll', wake)
      window.removeEventListener('keydown', wake)
      button?.removeEventListener('pointerenter', onEnter)
      button?.removeEventListener('pointerleave', onLeave)
      timers.forEach(clearTimeout)
      cancelAnimationFrame(frame)
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
        <g className={c('pb-hop')}>
          <g className={c('pb-body')}>
            <path d={SHAPE} />
            <g clipPath="url(#pb-shape)">
              <circle className={c('pb-light')} cx="36" cy="30" r="46" fill="url(#pb-light)" />
            </g>
            {[
              { cls: 'pb-eye e0', smile: 'M34.5 44Q40.5 28 46.5 44', open: 'M40.5 34V45' },
              { cls: 'pb-eye e1', smile: 'M53.5 44Q59.5 28 65.5 44', open: 'M59.5 34V45' },
            ].map((eye) => (
              <g key={eye.cls} className={c(eye.cls)}>
                <g className={c('pb-lid')}>
                  <path className={c('pb-smile')} d={eye.smile} />
                  <path className={c('pb-open')} d={eye.open} />
                </g>
              </g>
            ))}
          </g>
        </g>
      </svg>
    </div>
  )
}
