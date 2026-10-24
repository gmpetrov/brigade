'use client'

import { useEffect, useRef } from 'react'
import { c } from './parts'

const SHAPE = 'M56 0A44 56 0 0 1 100 56A40 44 0 0 1 60 100A60 54 0 0 1 0 46A56 46 0 0 1 56 0Z'

// The dancers, left to right: colour, eyes and size (in the title's em).
const DANCERS: { fill: string; smile?: boolean; size: number }[] = [
  { fill: 'oklch(0.78 0.16 155)', smile: true, size: 0.66 },
  { fill: 'oklch(0.74 0.17 50)', size: 0.6 },
  { fill: 'oklch(0.62 0.22 290)', size: 0.7 },
  { fill: 'oklch(0.87 0.14 90)', smile: true, size: 0.58 },
  { fill: 'oklch(0.72 0.13 250)', size: 0.64 },
  { fill: 'oklch(0.8 0.08 20)', smile: true, size: 0.6 },
]

// In the title's em and seconds.
const GRAVITY = 34
// How far apart their spots are, as a share of their widths: about 1, they touch.
const PACK = 1
// Each one's body, for bumping into the others: a circle in its box (share of its width).
const BODY = { x: 0.5, y: 0.52, r: 0.49 }

type Dancer = {
  home: number
  x: number
  y: number
  vx: number
  vy: number
  size: number
  // Squash (positive is flatter) and its speed, a damped spring.
  q: number
  qv: number
  lean: number
  grounded: boolean
  next: number
}

const random = (min: number, max: number) => min + Math.random() * (max - min)

/**
 * Pebbles dancing on "AI teammates", side by side, each standing on the letters under it:
 * its own outline against the glyphs' tops, measured from the font, so one sits lower on an
 * "e" than on a "t" and always touches. Each jumps on its own at random, small hops mostly
 * and a bigger one now and then, falls back under gravity, squashes on landing and springs
 * back, and leans as it moves. They bump into each other and never overlap; a soft pull
 * brings each back to its spot.
 * It runs only while the title shows; under reduced motion they stand still on the letters.
 */
export function Dancers() {
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const box = ref.current
    const word = box?.parentElement
    const text = word?.firstChild
    if (!box || !word || !text || text.nodeType !== Node.TEXT_NODE) return
    const els = [...box.children] as HTMLElement[]
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    let em = 1
    // The letters' outline seen from above: for each px column from `start`, in px from the
    // box's top, the highest ink of the word there (Infinity between letters).
    let start = 0
    let tops = new Float32Array(0)
    let dancers: Dancer[] = []

    // Draws the word in a canvas with the title's font and reads, column by column, where
    // its ink starts: the true outline of each glyph, the t's cross and the a's curve
    // included, placed on the page's baseline (where the zero-height probe sits).
    const measure = () => {
      const probe = word.querySelector<HTMLElement>('[data-baseline]')
      const chars = text.textContent ?? ''
      const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
      if (!probe || !ctx || !chars) return
      const style = getComputedStyle(word)
      em = parseFloat(style.fontSize)
      const range = document.createRange()
      range.selectNodeContents(text)
      const rect = range.getBoundingClientRect()
      const origin = box.getBoundingClientRect()
      const baseline = probe.getBoundingClientRect().top - origin.top
      const scale = 2
      const font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
      ctx.font = font
      if (style.letterSpacing !== 'normal') ctx.letterSpacing = style.letterSpacing
      const width = Math.ceil(ctx.measureText(chars).width)
      // Fit the drawing to the page's own width, in case spacing differs a hair.
      const sx = width ? rect.width / width : 1
      const canvas = ctx.canvas
      canvas.width = Math.ceil(rect.width * scale) + 4
      canvas.height = Math.ceil(em * 1.6 * scale)
      ctx.font = font
      if (style.letterSpacing !== 'normal') ctx.letterSpacing = style.letterSpacing
      ctx.setTransform(scale * sx, 0, 0, scale, 0, 0)
      ctx.textBaseline = 'alphabetic'
      ctx.fillText(chars, 0, em * 1.3)
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
      start = rect.left - origin.left
      tops = new Float32Array(Math.ceil(rect.width)).fill(Infinity)
      for (let col = 0; col < tops.length; col++) {
        // The highest ink across this page pixel's two canvas columns.
        for (let row = 0; row < canvas.height; row++) {
          const i = (row * canvas.width + col * scale) * 4 + 3
          if (data[i]! > 110 || data[i + 4]! > 110) {
            tops[col] = baseline - (em * 1.3 - row / scale)
            break
          }
        }
      }
    }

    // The pebble's underside: for each of SLICES slices across its box, how low its outline
    // goes (share of its width), read from the drawn shape itself.
    const SLICES = 48
    const under = new Array<number>(SLICES + 1).fill(-1)
    const outline = els[0]?.querySelector('path')
    if (outline) {
      const length = outline.getTotalLength()
      for (let k = 0; k <= 800; k++) {
        const p = outline.getPointAtLength((k / 800) * length)
        const slice = Math.round((p.x / 100) * SLICES)
        under[slice] = Math.max(under[slice]!, p.y / 100)
      }
    }

    // Where a pebble of width w at x (its box's left) comes to rest on the letters: the box
    // top at which its underside first touches the word's ink, column by column. Over no
    // letter at all, it rests on the lowest of them.
    const rest = (x: number, w: number) => {
      let top = Infinity
      const from = Math.max(0, Math.floor(x - start))
      const to = Math.min(tops.length - 1, Math.ceil(x + w - start))
      for (let col = from; col <= to; col++) {
        const ink = tops[col]!
        if (ink === Infinity) continue
        const u = under[Math.round(((col + start - x) / w) * SLICES)]
        if (u === undefined || u < 0) continue
        top = Math.min(top, ink - u * w)
      }
      if (top !== Infinity) return top
      let lowest = -Infinity
      for (const ink of tops) if (ink !== Infinity) lowest = Math.max(lowest, ink)
      return lowest - w
    }

    const place = () => {
      measure()
      if (!tops.length) return
      const end = start + tops.length
      const widths = DANCERS.map((d) => d.size * em)
      const row = widths.reduce((sum, w) => sum + w * PACK, 0)
      let x = start + (end - start - row) / 2
      dancers = DANCERS.map((d, i) => {
        const w = widths[i]!
        const home = x
        x += w * PACK
        els[i]!.style.width = `${w}px`
        return {
          home,
          x: home,
          y: rest(home, w),
          vx: 0,
          vy: 0,
          size: w,
          q: 0,
          qv: 0,
          lean: 0,
          grounded: true,
          next: random(0.2, 1.6),
        }
      })
    }

    const draw = () =>
      dancers.forEach((d, i) => {
        const el = els[i]
        if (!el) return
        // Squash keeps the feet down: it scales from the bottom.
        el.style.transform = `translate(${d.x}px, ${d.y}px) rotate(${d.lean}rad) scale(${1 + d.q}, ${1 - d.q})`
      })

    const step = (dt: number) => {
      const g = GRAVITY * em
      for (const d of dancers) {
        d.next -= dt
        if (d.grounded && d.next <= 0) {
          // Mostly small hops, a bigger one now and then, a little to one side.
          const h = (Math.random() < 0.2 ? random(0.35, 0.6) : random(0.08, 0.25)) * em
          d.vy = -Math.sqrt(2 * g * h)
          d.vx = random(-1, 1) * 0.35 * em
          d.grounded = false
          // A push off the ground stretches it a little.
          d.qv -= 2
          d.next = random(0.3, 2.4)
        }
        if (!d.grounded) {
          d.vy += g * dt
          d.x += d.vx * dt
          d.y += d.vy * dt
          const floor = rest(d.x, d.size)
          if (d.y >= floor && d.vy > 0) {
            d.y = floor
            const impact = d.vy / em
            // A small bounce off the letter, and a squash as hard as the landing.
            d.vy = impact > 4 ? -d.vy * 0.2 : 0
            d.grounded = d.vy === 0
            d.qv += Math.min(impact, 12) * 0.7
            d.vx *= 0.4
          }
        } else {
          // Standing: slide back toward its spot, following the letters under it.
          d.vx += (d.home - d.x) * 24 * dt - d.vx * 8 * dt
          d.x += d.vx * dt
          d.y = rest(d.x, d.size)
        }
        // The squash spring, and the lean following the sideways speed.
        d.qv += (-260 * d.q - 12 * d.qv) * dt
        d.q = Math.max(-0.1, Math.min(0.2, d.q + d.qv * dt))
        d.lean += ((d.vx / em) * 0.1 - d.lean) * Math.min(1, 10 * dt)
      }
      // They never pass through each other: two bodies that overlap are pushed apart along
      // the line between them and bounce off it. One standing only moves sideways (the
      // letters hold it up); one in the air takes the rest.
      for (let i = 0; i < dancers.length; i++) {
        for (let j = i + 1; j < dancers.length; j++) {
          const a = dancers[i]!
          const b = dancers[j]!
          const ax = a.x + BODY.x * a.size
          const ay = a.y + BODY.y * a.size
          const bx = b.x + BODY.x * b.size
          const by = b.y + BODY.y * b.size
          const dx = bx - ax
          const dy = by - ay
          const dist = Math.hypot(dx, dy)
          const min = BODY.r * (a.size + b.size)
          if (dist === 0 || dist >= min) continue
          const nx = dx / dist
          const ny = dy / dist
          const push = min - dist
          const share = a.grounded === b.grounded ? 0.5 : a.grounded ? 0 : 1
          a.x -= nx * push * share
          b.x += nx * push * (1 - share)
          if (!a.grounded) a.y -= ny * push * share
          if (!b.grounded) b.y += ny * push * (1 - share)
          // Sideways, a standing one still gives way a little.
          if (a.grounded && b.grounded) continue
          if (a.grounded) a.x -= nx * push * 0.3
          if (b.grounded) b.x += nx * push * 0.3
          const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny
          if (vn >= 0) continue
          const jn = -1.3 * vn
          if (!a.grounded) {
            a.vx -= jn * nx * share
            a.vy -= jn * ny * share
          }
          if (!b.grounded) {
            b.vx += jn * nx * (1 - share)
            b.vy += jn * ny * (1 - share)
          }
        }
      }
      for (const d of dancers) if (d.grounded) d.y = rest(d.x, d.size)
    }

    let frame = 0
    let last = 0
    let visible = false
    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 1 / 30)
      last = now
      // A few small steps a frame keep landings exact.
      for (let k = 0; k < 4; k++) step(dt / 4)
      draw()
      frame = requestAnimationFrame(tick)
    }
    const run = () => {
      if (still || !visible || frame) return
      last = performance.now()
      frame = requestAnimationFrame(tick)
    }
    const stop = () => {
      cancelAnimationFrame(frame)
      frame = 0
    }

    const setup = () => {
      place()
      draw()
      box.setAttribute('data-ready', '')
    }
    setup()
    // The glyphs' tops depend on the font: measure again once it has loaded.
    void document.fonts.ready.then(setup)
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false
      if (visible) run()
      else stop()
    })
    observer.observe(word)
    let width = window.innerWidth
    const onResize = () => {
      if (window.innerWidth === width) return
      width = window.innerWidth
      setup()
    }
    window.addEventListener('resize', onResize)
    return () => {
      stop()
      observer.disconnect()
      window.removeEventListener('resize', onResize)
    }
  }, [])

  return (
    <>
      {/* Zero-height, on the baseline: where the letters stand, for measuring them. */}
      <span className={c('dn-base')} data-baseline aria-hidden="true" />
      <span ref={ref} className={c('dancers')} aria-hidden="true">
        {DANCERS.map((d, i) => (
          <span key={i} className={c('dancer')}>
            <svg viewBox="0 0 100 100">
              <path d={SHAPE} fill={d.fill} />
              <g className={c('dn-blink')} style={{ animationDuration: `${3.3 + i * 0.7}s` }}>
                <path
                  className={c('dn-eye')}
                  d={
                    d.smile
                      ? 'M34.5 44Q40.5 28 46.5 44M53.5 44Q59.5 28 65.5 44'
                      : 'M40.5 34V45M59.5 34V45'
                  }
                />
              </g>
            </svg>
          </span>
        ))}
      </span>
    </>
  )
}
