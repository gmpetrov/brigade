import type { CSSProperties } from 'react'
import { cn } from '@/lib/utils'

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

/** An agent's picture: a softly morphing pebble with pill eyes that blink into happy
 * arcs, unique to its seed (the agent's id) and the same wherever it shows. Size it
 * with the className (`size-8`). */
export function PebbleAvatar({
  seed,
  className,
  title,
}: {
  seed: string
  className?: string
  title?: string
}) {
  return (
    <span
      data-slot="avatar"
      role="img"
      aria-label={title}
      title={title}
      className={cn('pebble relative flex size-8 shrink-0', className)}
      style={pebbleStyle(seed)}
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
    </span>
  )
}
