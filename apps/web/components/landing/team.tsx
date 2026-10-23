'use client'

import { useEffect, useRef, type CSSProperties } from 'react'
import { pebbleStyle } from '@/components/pebble-avatar'
import { c, Icon } from './parts'

const random = (min: number, max: number) => min + Math.random() * (max - min)
const pick = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)]!

// Three teammates of the avatars' family, in the page's ink: their outlines and eyes come
// from the same seeds as in the product, their colours from the page. Placed in the art box.
const TEAM = [
  { seed: 'riley', ink: '100%', size: 460, left: 250, top: 250 },
  { seed: 'sam', ink: '78%', size: 270, left: 40, top: -70 },
  { seed: 'mark', ink: '56%', size: 200, left: 400, top: 30 },
]
const style = (m: (typeof TEAM)[number]) =>
  ({
    ...pebbleStyle(m.seed),
    '--pebble-c1': `color-mix(in oklch, var(--foreground) ${m.ink}, var(--background))`,
    '--pebble-c2': `color-mix(in oklch, var(--foreground) calc(${m.ink} - 14%), var(--background))`,
    '--pebble-eye': 'var(--background)',
    left: `${m.left}px`,
    top: `${m.top}px`,
    width: `${m.size}px`,
    height: `${m.size}px`,
  }) as CSSProperties

// How long the eyes keep following the pointer after it stopped.
const POINTER_HOLD = 2500

/**
 * A team, not a bot: three pebbles peek in from the edge of the final call. Left alone they
 * look around, blink, look at one another and pass a finished task along, and the one who
 * gets it smiles. When the visitor moves, they all turn to the pointer; on Sign up they all
 * smile. Nothing loops: each beat is drawn at random. Each move only sets CSS variables or
 * data attributes that transitions ease. Still under reduced motion and off screen.
 */
export function Team() {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const art = ref.current
    if (!art || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const pebbles = [...art.querySelectorAll<HTMLElement>('[data-pebble]')]
    const card = art.querySelector<HTMLElement>('[data-card]')
    let visible = false
    let hovering = false
    let busy = false
    let lastPointer = 0
    const timers: number[] = []
    const later = (fn: () => void, ms: number) => timers.push(window.setTimeout(fn, ms))
    const center = (el: Element) => {
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height * 0.42 }
    }
    // Turns a pebble's eyes toward a point of the page.
    const lookAt = (p: HTMLElement, x: number, y: number) => {
      const from = center(p)
      const dx = x - from.x
      const dy = y - from.y
      const len = Math.hypot(dx, dy) || 1
      const reach = Math.min(1, len / 300)
      p.style.setProperty('--lx', `${(dx / len) * reach * 9}%`)
      p.style.setProperty('--ly', `${(dy / len) * reach * 7}%`)
    }
    const lookAround = (p: HTMLElement) => {
      p.style.setProperty('--lx', `${random(-9, 9)}%`)
      p.style.setProperty('--ly', `${random(-6, 6)}%`)
    }
    const smile = (p: HTMLElement, on: boolean) => {
      if (on) p.dataset.smile = ''
      else delete p.dataset.smile
    }
    const following = () => performance.now() - lastPointer < POINTER_HOLD

    // Each pebble, on its own: glances somewhere and blinks, at its own random pace.
    pebbles.forEach((p) => {
      const glance = () => {
        if (visible && !busy && !following()) lookAround(p)
        later(glance, Math.random() < 0.3 ? random(200, 500) : random(900, 3400))
      }
      const blink = () => {
        if (visible) {
          p.dataset.blink = ''
          later(() => delete p.dataset.blink, 140)
        }
        later(blink, random(2200, 6500))
      }
      later(glance, random(200, 1200))
      later(blink, random(800, 4000))
    })

    // A beat of teamwork: two look at each other, one passes a done task to the other, who
    // smiles; the third watches.
    const scene = () => {
      if (visible && !busy && !hovering && !following() && card && pebbles.length > 1) {
        busy = true
        const giver = pick(pebbles)
        const taker = pick(pebbles.filter((p) => p !== giver))
        const other = pebbles.find((p) => p !== giver && p !== taker)
        const a = center(giver)
        const b = center(taker)
        lookAt(giver, b.x, b.y)
        later(() => lookAt(taker, a.x, a.y), 250)
        if (other) later(() => lookAt(other, a.x, a.y), 400)
        const box = art.getBoundingClientRect()
        later(() => {
          card.style.transition = 'none'
          card.style.setProperty('--cx', `${a.x - box.left}px`)
          card.style.setProperty('--cy', `${a.y - box.top}px`)
          card.dataset.show = ''
          card.getBoundingClientRect()
          card.style.transition = ''
          card.style.setProperty('--cx', `${b.x - box.left}px`)
          card.style.setProperty('--cy', `${b.y - box.top}px`)
          if (other) lookAt(other, b.x, b.y)
        }, 650)
        later(() => {
          delete card.dataset.show
          smile(taker, true)
          smile(giver, true)
        }, 1650)
        later(() => {
          if (!hovering) {
            smile(taker, false)
            smile(giver, false)
          }
          busy = false
        }, 3100)
      }
      later(scene, random(2600, 6000))
    }

    let frame = 0
    let pointer = { x: 0, y: 0 }
    const onPointer = (e: PointerEvent) => {
      lastPointer = performance.now()
      pointer = { x: e.clientX, y: e.clientY }
      if (!visible || frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        art.dataset.follow = ''
        pebbles.forEach((p) => lookAt(p, pointer.x, pointer.y))
        later(() => {
          if (!following()) delete art.dataset.follow
        }, POINTER_HOLD)
      })
    }
    const button = art.closest('section')?.querySelector('a')
    const onEnter = () => {
      hovering = true
      pebbles.forEach((p) => smile(p, true))
    }
    const onLeave = () => {
      hovering = false
      pebbles.forEach((p) => smile(p, false))
    }

    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false
    })
    observer.observe(art)
    window.addEventListener('pointermove', onPointer, { passive: true })
    button?.addEventListener('pointerenter', onEnter)
    button?.addEventListener('pointerleave', onLeave)
    later(scene, random(1200, 2500))
    return () => {
      observer.disconnect()
      window.removeEventListener('pointermove', onPointer)
      button?.removeEventListener('pointerenter', onEnter)
      button?.removeEventListener('pointerleave', onLeave)
      timers.forEach(clearTimeout)
      cancelAnimationFrame(frame)
    }
  }, [])

  return (
    <div ref={ref} className={c('art team')} aria-hidden="true">
      {TEAM.map((m) => (
        <div key={m.seed} data-pebble className={`pebble ${c('tm')}`} style={style(m)}>
          <span className="pebble-body" />
          <span className={c('tm-face')}>
            {[0, 1].map((i) => (
              <span key={i} className="pebble-eye">
                <span className={c('tm-pill')} />
                <span className={c('tm-smile')} />
              </span>
            ))}
          </span>
        </div>
      ))}
      <span data-card className={c('tm-card')}>
        <Icon name="check" />
        Done
      </span>
    </div>
  )
}
