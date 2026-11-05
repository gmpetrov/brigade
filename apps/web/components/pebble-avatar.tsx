'use client'
import { useCallback, useEffect, useRef, type CSSProperties } from 'react'
import { cn } from '@/lib/utils'

/**
 * One watcher for every pebble: those out of sight stand still. Each morph repaints its
 * pebble on every frame, which a long thread's hundreds of replies, each with its
 * teammate's pebble, turned into seconds of work.
 */
let watcher: IntersectionObserver | undefined
function stillOutOfSight(node: HTMLElement) {
  watcher ??= new IntersectionObserver((entries) => {
    for (const e of entries) e.target.toggleAttribute('data-still', !e.isIntersecting)
  })
  watcher.observe(node)
  return () => watcher?.unobserve(node)
}

/** A 32-bit hash of the seed (cyrb53's mixing, folded down). */
function hash(seed: string) {
  let a = 0xdeadbeef
  let b = 0x41c6ce57
  for (let i = 0; i < seed.length; i++) {
    const k = seed.charCodeAt(i)
    a = Math.imul(a ^ k, 2654435761)
    b = Math.imul(b ^ k, 1597334677)
  }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909)
  return a >>> 0
}

/** mulberry32: the same seed gives the same sequence everywhere. */
function random(seed: number) {
  let x = seed
  return () => {
    x = (x + 0x6d2b79f5) | 0
    let t = Math.imul(x ^ (x >>> 15), 1 | x)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The pebble's look, all of it drawn from the seed: colours, the three outlines it
 * morphs between, its eyes and when it blinks and glances. */
export function pebbleStyle(seed: string): CSSProperties {
  const r = random(hash(seed))
  const between = (min: number, max: number) => min + r() * (max - min)
  const whole = (min: number, max: number) => Math.round(between(min, max))
  const pct = (n: number) => `${n.toFixed(1)}%`
  const secs = (n: number) => `${n.toFixed(2)}s`
  // A blob outline: opposite corners' radii add up to 100%, so it stays a closed shape.
  const outline = () => {
    const [a, b, c, d] = [whole(30, 70), whole(30, 70), whole(30, 70), whole(30, 70)]
    return `${a}% ${100 - a}% ${b}% ${100 - b}% / ${c}% ${d}% ${100 - d}% ${100 - c}%`
  }
  const hue = whole(0, 359)
  const hue2 = (hue + (r() < 0.5 ? -1 : 1) * whole(30, 80) + 360) % 360
  const sat = whole(75, 95)
  return {
    '--pebble-c1': `hsl(${hue} ${sat}% 68%)`,
    '--pebble-c2': `hsl(${hue2} ${sat}% 60%)`,
    '--pebble-eye': `hsl(${hue} 55% 11%)`,
    '--pebble-angle': `${whole(0, 359)}deg`,
    '--pebble-r1': outline(),
    '--pebble-r2': outline(),
    '--pebble-r3': outline(),
    '--pebble-morph': secs(between(5, 10)),
    '--pebble-morph-at': secs(-between(0, 10)),
    '--pebble-eye-w': pct(between(7.5, 9.5)),
    '--pebble-eye-h': pct(between(15, 19)),
    '--pebble-eye-gap': pct(between(8, 13)),
    '--pebble-eye-top': pct(between(33, 39)),
    '--pebble-eye-x': pct(between(-3, 3)),
    '--pebble-look': secs(between(5, 9)),
    '--pebble-look-at': secs(-between(0, 9)),
    '--pebble-blink': secs(between(4, 7)),
    '--pebble-blink-at': secs(-between(0, 7)),
  } as CSSProperties
}

/** A teammate's name in its pebble's colour (`.teammate-name` sets how light, for the
 * theme): the same teammate reads the same in the thread as its pebble does at the top. */
export function pebbleInk(seed: string): CSSProperties {
  return { '--pebble-c1': pebbleStyle(seed)['--pebble-c1' as keyof CSSProperties] } as CSSProperties
}

/** The Working line's pebble: solid grey, its eyes cut out in the colour of the page under
 * it. Grey is no teammate's colour, so it reads as a status and never as someone. */
const NEUTRAL = {
  '--pebble-c1': 'var(--muted-foreground)',
  '--pebble-c2': 'var(--muted-foreground)',
  '--pebble-eye': 'var(--background)',
} as CSSProperties

/** What the Working pebble's eyes do, by the kind of step it is on. */
export type PebbleExpression = 'read' | 'think' | 'focus' | 'curious' | 'aha' | 'glance'

/** Where the eyes look (x, y in % of the pebble) and each eye's size, [width, height]. */
type Pose = { x: number; y: number; eyes: [[number, number], [number, number]] }
const pose = (x: number, y: number, sx = 1, sy = 1, right?: [number, number]): Pose => ({
  x,
  y,
  eyes: [[sx, sy], right ?? [sx, sy]],
})
const SPRING = 'cubic-bezier(.34,1.56,.64,1)'
const EASE = 'cubic-bezier(.4,0,.2,1)'
/** A pose, how long the eyes take to reach it (ms), how long they stay there, and how. */
type Move = [Pose, number, number, string?]
const EXPRESSIONS: Record<PebbleExpression, Move[]> = {
  // Eyes down, scanning a line, back to the start of the next.
  read: [
    [pose(-7, 7, 1, 0.85), 350, 250],
    [pose(7, 7, 1, 0.85), 900, 150, EASE],
    [pose(-7, 10, 1, 0.85), 260, 200],
    [pose(7, 10, 1, 0.85), 900, 150, EASE],
  ],
  // Up and to the side, drifting slowly.
  think: [
    [pose(7, -8, 1, 0.92), 450, 900],
    [pose(-5, -9, 1, 0.92), 1200, 600, EASE],
    [pose(3, -10, 1, 0.92), 900, 500, EASE],
  ],
  // A squint, as when reading up close.
  focus: [
    [pose(0, 2, 1.05, 0.5), 300, 1300],
    [pose(2, 2, 1.05, 0.42), 700, 600, EASE],
  ],
  // One eye bigger, the other squinted: a raised brow.
  curious: [
    [pose(4, -2, 1.15, 1.3, [0.95, 0.72]), 350, 1300],
    [pose(2, -1, 1.05, 1.1, [1, 0.85]), 600, 500, EASE],
  ],
  // Both widen, then settle.
  aha: [
    [pose(0, -3, 1.3, 1.38), 260, 800],
    [pose(0, 0), 400, 600],
  ],
  // A quick look left, then right.
  glance: [
    [pose(-8, 0), 220, 500],
    [pose(8, 0), 260, 500],
    [pose(0, 0), 300, 300],
  ],
}

/**
 * Moves the pebble's eyes through its expression, one move after another, by writing their
 * transforms (no re-render). A new expression takes over once the move under way ends, so the
 * eyes never jump. Still while out of sight (`data-still`) and for those who ask for less motion.
 */
function useExpression(expression: PebbleExpression | undefined) {
  const node = useRef<HTMLElement | null>(null)
  const current = useRef(expression)
  useEffect(() => {
    current.current = expression
  }, [expression])
  const on = expression !== undefined
  useEffect(() => {
    const el = node.current
    if (!on || !el || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const face = el.querySelector<HTMLElement>('.pebble-face')
    const eyes = [...el.querySelectorAll<HTMLElement>('.pebble-eye')]
    let queue: Move[] = []
    let timer: ReturnType<typeof setTimeout>
    const next = () => {
      if (el.hasAttribute('data-still')) {
        timer = setTimeout(next, 1_000)
        return
      }
      if (!queue.length) queue = [...EXPRESSIONS[current.current ?? 'think']]
      const [p, ms, hold, ease = SPRING] = queue.shift()!
      const transition = `transform ${ms}ms ${ease}`
      if (face) {
        face.style.transition = transition
        face.style.transform = `translate(${p.x}%, ${p.y}%)`
      }
      eyes.forEach((eye, i) => {
        const [sx, sy] = p.eyes[i] ?? [1, 1]
        eye.style.transition = transition
        eye.style.transform = `scale(${sx}, ${sy})`
      })
      timer = setTimeout(next, ms + hold)
    }
    next()
    return () => clearTimeout(timer)
  }, [on])
  return node
}

/** An agent's picture: a softly morphing pebble with pill eyes that blink into happy
 * arcs, unique to its seed (the agent's id) and the same wherever it shows. The chief
 * wears a small gold crown. Size it with the className (`size-8`). */
export function PebbleAvatar({
  seed,
  className,
  title,
  crown = false,
  tone,
  expression,
}: {
  seed: string
  className?: string
  title?: string
  crown?: boolean
  /** In neutral grey, its eyes the page's own (a Working line), not its seed's colours. */
  tone?: 'neutral'
  /** Its eyes move as this says (EXPRESSIONS above) instead of glancing around now and then. */
  expression?: PebbleExpression
}) {
  const expressive = useExpression(expression)
  const ref = useCallback(
    (node: HTMLElement | null) => {
      expressive.current = node
      return node ? stillOutOfSight(node) : undefined
    },
    [expressive],
  )
  return (
    <span
      ref={ref}
      data-expressive={expression ? '' : undefined}
      data-slot="avatar"
      role="img"
      aria-label={title}
      title={title}
      className={cn('pebble relative flex size-8 shrink-0', className)}
      style={tone === 'neutral' ? { ...pebbleStyle(seed), ...NEUTRAL } : pebbleStyle(seed)}
    >
      <span className="pebble-body" />
      <span className="pebble-face">
        {[0, 1].map((i) => (
          <span key={i} className="pebble-eye">
            <span className="pebble-pill" />
            <span className="pebble-smile" />
          </span>
        ))}
      </span>
      {crown && (
        <svg className="pebble-crown" viewBox="0 0 36 24" aria-hidden>
          <path d="M5 22 2 6l9 8 7-12 7 12 9-8-3 16Z" fill="#f5c542" />
          <circle cx="2" cy="6" r="2" fill="#fde68a" />
          <circle cx="18" cy="2" r="2" fill="#fde68a" />
          <circle cx="34" cy="6" r="2" fill="#fde68a" />
        </svg>
      )}
    </span>
  )
}
