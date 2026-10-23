'use client'

import { type CSSProperties, useEffect, useRef } from 'react'
import { c } from './parts'

const SHAPE = 'M56 0A44 56 0 0 1 100 56A40 44 0 0 1 60 100A60 54 0 0 1 0 46A56 46 0 0 1 56 0Z'

// The pebbles in the order they fall: colour and eyes, and how long each one's glance and
// blink take once it rests, never the same twice.
const PEBBLES: { fill: string; smile?: boolean; look: number; blink: number }[] = [
  { fill: 'oklch(0.62 0.22 290)', look: 7, blink: 5.2 },
  { fill: 'oklch(0.78 0.16 155)', smile: true, look: 8.3, blink: 6.1 },
  { fill: 'oklch(0.74 0.17 50)', look: 6.4, blink: 4.7 },
  { fill: 'oklch(0.72 0.13 250)', look: 9.1, blink: 5.8 },
  { fill: 'oklch(0.8 0.08 20)', look: 7.7, blink: 6.6 },
  { fill: 'oklch(0.95 0 0)', smile: true, look: 6.9, blink: 4.9 },
  { fill: 'oklch(0.87 0.14 90)', look: 8.8, blink: 5.5 },
  { fill: 'oklch(0.72 0.13 250)', look: 7.3, blink: 6.3 },
  { fill: 'oklch(0.62 0.22 290)', look: 8, blink: 5 },
  { fill: 'oklch(0.78 0.16 155)', smile: true, look: 6.2, blink: 4.4 },
]

// The physics, in px and seconds: a fixed step, a few steps a frame.
const STEP = 1 / 240
const GRAVITY = 2600
// How much speed a bounce keeps, against the button and the floor, and between pebbles.
const BOUNCE = 0.45
const BOUNCE_PEBBLES = 0.3
const FRICTION = 0.35
// One falls every this many seconds, from this far above the card.
const EVERY = 0.42
const FALL_FROM = 90
// The space between a plan's list and its button (.feat's bottom margin), in px.
const FEAT_GAP = 34
// The smallest a pebble gets, in px, however short the room.
const MIN_R = 15
// A hit this fast squashes the button and makes the pebble wince.
const HARD_HIT = 380

type Body = {
  x: number
  y: number
  vx: number
  vy: number
  // Its angle in the physics, and the one drawn: once it has landed, the drawn one stands up.
  a: number
  shown: number
  w: number
  r: number
  landed: boolean
}
type World = {
  left: number
  right: number
  floor: number
  top: number
  // The button, as a capsule: a segment and its radius.
  cap: { x1: number; x2: number; y: number; r: number }
  r: number
  narrow: boolean
  count: number
  spawnX: (i: number) => number
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))

/**
 * Pebbles fall one by one on the Cloud plan's Start with Cloud button, hit it (it gives a little), bounce
 * off it and each other and come to rest on the card's floor beside it, dancing from the moment each one lands.
 * A small rigid-body simulation: circles with gravity, restitution and rolling friction, against
 * the button as a capsule, the card's sides and the button's baseline as the floor. It starts
 * once the button is in view, stops when everything rests, and under reduced motion or on a
 * resize jumps straight to where they come to rest.
 */
export function PebbleRain() {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const box = ref.current
    const plans = box?.parentElement
    const button = plans?.querySelector<HTMLElement>('[data-pebble-target]')
    const card = button?.closest<HTMLElement>('[data-pebble-card]')
    if (!box || !plans || !button || !card) return
    const els = [...box.children] as HTMLElement[]
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const measure = (): World => {
      let o = plans.getBoundingClientRect()
      let b = button.getBoundingClientRect()
      let k = card.getBoundingClientRect()
      const h = b.height
      const style = getComputedStyle(card)
      const pad = parseFloat(style.paddingLeft)
      // Beside the button when there is room for a row of them there; otherwise anywhere
      // across the card, on the button or beside it, inside the card's padding.
      const inner = k.right - o.left - card.clientLeft - 8
      const beside = inner - (b.right - o.left)
      const narrow = beside < PEBBLES.length * 2.1 * MIN_R
      const left = narrow ? k.left - o.left + pad : b.left - o.left
      const right = narrow ? k.right - o.left - pad : inner
      // All of them in one row, as big as the room allows; never smaller than MIN_R, when
      // some stack instead. On the button they stay smaller.
      const r = clamp(
        (narrow ? right - left : beside) / (PEBBLES.length * 2.1),
        MIN_R,
        h * (narrow ? 0.36 : 0.5),
      )
      // On the button, they need room under the plan's last line to land and hop without
      // covering it: the button moves down by what the list's margin lacks.
      card.style.setProperty(
        '--rain-room',
        narrow ? `${Math.max(0, r * 2.08 + 14 - FEAT_GAP)}px` : '0px',
      )
      ;[o, b, k] = [plans, button, card].map((el) => el.getBoundingClientRect()) as [
        DOMRect,
        DOMRect,
        DOMRect,
      ]
      // They only show inside the card: one falling comes in through its top edge.
      box.style.clipPath = `inset(${k.top - o.top}px ${o.right - k.right}px ${o.bottom - k.bottom}px ${k.left - o.left}px round ${style.borderTopLeftRadius})`
      const cap = {
        x1: b.left - o.left + h / 2,
        x2: b.right - o.left - h / 2,
        y: b.top - o.top + h / 2,
        r: h / 2,
      }
      return {
        left,
        right,
        floor: b.bottom - o.top,
        top: k.top - o.top,
        cap,
        r,
        narrow,
        count: PEBBLES.length,
        // Beside, on the button's rounded right end, so they glance off it toward the free
        // space; otherwise spread across the card (by the golden ratio) so they land side by side.
        spawnX: narrow
          ? (i) => left + r + ((i * 0.618 + 0.3) % 1) * (right - left - 2 * r)
          : () => cap.x2 + 16 + Math.random() * 14,
      }
    }

    let world = measure()
    let bodies: Body[] = []
    let time = 0
    let restingFor = 0
    let frame = 0
    let last = 0
    let lastSquash = 0
    let started = false

    const reset = () => {
      world = measure()
      bodies = []
      time = 0
      restingFor = 0
      els.forEach((el, i) => {
        el.style.width = el.style.height = `${world.r * 2.08}px`
        el.toggleAttribute('data-off', i >= world.count)
        el.removeAttribute('data-on')
        el.removeAttribute('data-dance')
      })
    }

    const squash = () => {
      if (time - lastSquash < 0.15) return
      lastSquash = time
      button.animate(
        [
          { transform: 'none' },
          { transform: 'translateY(3px) scale(1.04, 0.9)' },
          { transform: 'translateY(-1px) scale(0.99, 1.02)' },
          { transform: 'none' },
        ],
        { duration: 260, easing: 'ease-out' },
      )
    }
    const wince = (i: number) => {
      const el = els[i]
      if (!el || el.hasAttribute('data-hit')) return
      el.setAttribute('data-hit', '')
      window.setTimeout(() => el.removeAttribute('data-hit'), 280)
    }

    // A contact with something that does not move, along its normal (nx, ny) pointing out of
    // it: the bounce, then friction at the contact point, which also spins the pebble.
    const contact = (b: Body, nx: number, ny: number, live: boolean) => {
      const vn = b.vx * nx + b.vy * ny
      if (vn >= 0) return 0
      // Slow contacts do not bounce, or a resting pebble would jitter.
      const e = -vn > 120 ? BOUNCE : 0
      const jn = -(1 + e) * vn
      b.vx += jn * nx
      b.vy += jn * ny
      // The contact point's speed along the surface; a disc's friction impulse that would
      // stop it is a third of it, held under the Coulomb limit.
      const tx = -ny
      const ty = nx
      const vt = b.vx * tx + b.vy * ty - b.w * b.r
      const jt = clamp(
        -vt / 3,
        -FRICTION * Math.max(jn, GRAVITY * STEP),
        FRICTION * Math.max(jn, GRAVITY * STEP),
      )
      b.vx += jt * tx
      b.vy += jt * ty
      b.w -= (2 * jt) / b.r
      return live ? -vn : 0
    }

    // It touched the ground: it starts dancing at once, while it still bounces and rolls.
    const land = (i: number, live: boolean) => {
      const b = bodies[i]
      if (!b || b.landed) return
      b.landed = true
      // Stand up the short way round.
      b.shown = b.a - Math.round(b.a / (2 * Math.PI)) * 2 * Math.PI
      if (live) els[i]?.setAttribute('data-dance', '')
    }

    const step = (live: boolean) => {
      const { cap } = world
      // A new pebble on schedule, from above the card.
      if (bodies.length < world.count && time >= bodies.length * EVERY) {
        const i = bodies.length
        bodies.push({
          x: world.spawnX(i),
          y: world.top - FALL_FROM,
          vx: (Math.random() - 0.5) * 40,
          vy: 0,
          a: 0,
          shown: 0,
          w: (Math.random() - 0.5) * 4,
          r: world.r,
          landed: false,
        })
        if (live) els[i]?.setAttribute('data-on', '')
      }
      for (const [i, b] of bodies.entries()) {
        b.vy += GRAVITY * STEP
        b.x += b.vx * STEP
        b.y += b.vy * STEP
        if (!b.landed) b.a += b.w * STEP
        // A little rolling resistance, so they come to rest.
        b.w *= 0.998
        if (b.y + b.r > world.floor) {
          b.y = world.floor - b.r
          contact(b, 0, -1, false)
          // A pebble is not a ball: on the floor it stops rolling soon.
          b.vx *= 0.985
          b.w *= 0.985
          land(i, live)
        }
        if (b.x - b.r < world.left) {
          b.x = world.left + b.r
          contact(b, 1, 0, false)
        }
        if (b.x + b.r > world.right) {
          b.x = world.right - b.r
          contact(b, -1, 0, false)
        }
        const px = clamp(b.x, cap.x1, cap.x2)
        const dx = b.x - px
        const dy = b.y - cap.y
        const d = Math.hypot(dx, dy)
        if (d > 0 && d < b.r + cap.r) {
          const nx = dx / d
          const ny = dy / d
          b.x = px + nx * (b.r + cap.r)
          b.y = cap.y + ny * (b.r + cap.r)
          if (contact(b, nx, ny, live) > HARD_HIT) {
            squash()
            wince(i)
          }
          // On a phone, the button is the ground they land on.
          if (world.narrow) land(i, live)
        }
      }
      // Between pebbles: push apart, then an equal and opposite bounce along the line between them.
      for (let i = 0; i < bodies.length; i++) {
        for (let j = i + 1; j < bodies.length; j++) {
          const p = bodies[i]!
          const q = bodies[j]!
          const dx = q.x - p.x
          const dy = q.y - p.y
          const d = Math.hypot(dx, dy)
          const min = p.r + q.r
          if (d === 0 || d >= min) continue
          const nx = dx / d
          const ny = dy / d
          const push = (min - d) / 2
          p.x -= nx * push
          p.y -= ny * push
          q.x += nx * push
          q.y += ny * push
          const vn = (q.vx - p.vx) * nx + (q.vy - p.vy) * ny
          if (vn >= 0) continue
          const e = -vn > 120 ? BOUNCE_PEBBLES : 0
          const jn = (-(1 + e) * vn) / 2
          p.vx -= jn * nx
          p.vy -= jn * ny
          q.vx += jn * nx
          q.vy += jn * ny
          // Friction where they touch: it slows their sliding past each other and spins both.
          const vt = (q.vx - p.vx) * -ny + (q.vy - p.vy) * nx - p.w * p.r - q.w * q.r
          const jt = clamp(-vt / 6, -FRICTION * jn, FRICTION * jn)
          p.vx += jt * ny
          p.vy -= jt * nx
          q.vx -= jt * ny
          q.vy += jt * nx
          p.w -= (2 * jt) / p.r
          q.w -= (2 * jt) / q.r
          if (live && -vn > HARD_HIT) {
            wince(i)
            wince(j)
          }
          // Falling on one that has landed is landing too.
          if (p.landed) land(j, live)
          if (q.landed) land(i, live)
        }
      }
      time += STEP
      const resting = bodies.every((b) => Math.hypot(b.vx, b.vy) < 10 && Math.abs(b.w) < 0.4)
      restingFor = bodies.length === world.count && resting ? restingFor + STEP : 0
      return restingFor > 0.4 || time > 20
    }

    // In the air it turns as the physics spins it; once landed it eases upright to dance,
    // whatever its roll (the CSS does the dance).
    const draw = (ease: number) =>
      bodies.forEach((b, i) => {
        const el = els[i]
        if (!el) return
        b.shown = b.landed ? b.shown * (1 - ease) : b.a
        const s = b.r * 2.08
        el.style.transform = `translate(${b.x - s / 2}px, ${b.y - s / 2}px) rotate(${b.shown}rad)`
      })

    // Straight to where they rest: for reduced motion and after a resize.
    const settle = () => {
      cancelAnimationFrame(frame)
      reset()
      while (!step(false));
      els.forEach((el, i) => {
        el.toggleAttribute('data-on', i < world.count)
        el.toggleAttribute('data-dance', i < world.count)
      })
      draw(1)
    }

    const tick = (now: number) => {
      // At most a few frames' worth after a stall, so a hidden tab does not explode it.
      let left = Math.min((now - last) / 1000, 0.05)
      last = now
      let done = false
      while (left > 0 && !done) {
        done = step(true)
        left -= STEP
      }
      draw(0.15)
      if (!done) frame = requestAnimationFrame(tick)
    }

    const start = () => {
      if (started) return
      started = true
      if (still) return settle()
      reset()
      last = performance.now()
      frame = requestAnimationFrame(tick)
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          observer.disconnect()
          start()
        }
      },
      { rootMargin: '0px 0px -15% 0px' },
    )
    observer.observe(button)
    let width = plans.clientWidth
    const resized = new ResizeObserver(() => {
      if (plans.clientWidth === width) return
      width = plans.clientWidth
      if (started) settle()
    })
    resized.observe(plans)
    return () => {
      observer.disconnect()
      resized.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [])

  return (
    <div ref={ref} className={c('rain')} aria-hidden="true" data-anim>
      {PEBBLES.map((p, i) => (
        <span
          key={i}
          className={c('rain-p')}
          style={{ '--l': `${p.look}s`, '--b': `${p.blink}s`, '--i': i } as CSSProperties}
        >
          <svg className={c('rain-d')} viewBox="0 0 100 100">
            <path d={SHAPE} fill={p.fill} />
            <g className={c('pl-look')}>
              <g className={c('pl-hit')}>
                <g className={c('pl-lid')}>
                  {/* Happy arcs, which every one wears while it dances. */}
                  <path
                    className={c(p.smile ? 'pl-eye' : 'pl-eye joy')}
                    d="M34.5 44Q40.5 28 46.5 44M53.5 44Q59.5 28 65.5 44"
                  />
                  {!p.smile && <path className={c('pl-eye open')} d="M40.5 34V45M59.5 34V45" />}
                </g>
              </g>
            </g>
          </svg>
        </span>
      ))}
    </div>
  )
}
