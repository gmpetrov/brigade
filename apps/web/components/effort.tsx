'use client'
// How hard a thread's teammates think: a slider like Claude's, Low to Max, with the
// model's own level marked Default (nothing is sent to the CLI there). In the composer's
// + menu, and next to send once it is off Default, as level bars that open it again.
// Max is a boost: a burst on reaching it, then energy running through the track.
import { EFFORTS, type Effort } from '@brigade/contracts'
import { CircleHelp } from 'lucide-react'
import { Popover } from 'radix-ui'
import { useEffect, useRef, useState } from 'react'
import { Hint } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/** The thread's effort (null: the model's own), that level, and a change to it. */
export type EffortPick = {
  value: Effort | null
  /** The model's own level: where the slider sits on Default. */
  fallback: Effort
  onPick: (effort: Effort | null) => void
}

const MAX = EFFORTS.length - 1
const level = (e: EffortPick) => EFFORTS.findIndex((x) => x.id === (e.value ?? e.fallback))
/** Off Default: shown next to send. */
export const effortChanged = (e: EffortPick) => e.value !== null && e.value !== e.fallback

/** One bar per level, lit up to this one; violet and moving at Max. */
export function EffortBars({ index, className }: { index: number; className?: string }) {
  return (
    <span aria-hidden className={cn('effort-bars', index === MAX && 'effort-max', className)}>
      {EFFORTS.map((e, i) => (
        <i key={e.id} data-on={i <= index || undefined} style={{ height: 4 + i * 2 }} />
      ))}
    </span>
  )
}

/** The slider. `later`: a turn is running, which keeps the effort it started with. */
export function EffortSlider({
  effort,
  later,
  autoFocus,
}: {
  effort: EffortPick
  later?: boolean
  /** Focus the track on mount, so the arrows move it at once (in the + menu). */
  autoFocus?: boolean
}) {
  const committed = level(effort)
  // Where the handle is while dragging; picked when it is let go.
  const [dragged, setDragged] = useState<number>()
  // The ? opens a line on what effort is.
  const [help, setHelp] = useState(false)
  const index = dragged ?? committed
  const track = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (autoFocus) track.current?.focus()
  }, [autoFocus])
  const card = useRef<HTMLDivElement>(null)
  const max = index === MAX
  const onDefault = EFFORTS[index]!.id === effort.fallback

  const pick = (i: number) => {
    setDragged(undefined)
    const id = EFFORTS[i]!.id
    const value = id === effort.fallback ? null : id
    if (value !== effort.value) effort.onPick(value)
  }
  const at = (x: number) => {
    const r = track.current!.getBoundingClientRect()
    const f = Math.min(1, Math.max(0, (x - r.left - 12) / (r.width - 24)))
    return Math.round(f * MAX)
  }

  // Reaching Max: a flash, a shockwave and sparks from the handle, and the card jolts.
  // Then embers rise off the track for as long as it stays there.
  const was = useRef(index)
  useEffect(() => {
    const from = was.current
    was.current = index
    const el = track.current
    if (!max || !el || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const fx = (name: string, style: Record<string, string>, ms: number) => {
      const node = document.createElement('div')
      node.className = `effort-fx effort-${name}`
      for (const [k, v] of Object.entries(style)) node.style.setProperty(k, v)
      el.appendChild(node)
      setTimeout(() => node.remove(), ms)
    }
    const timers: ReturnType<typeof setTimeout>[] = []
    if (from !== MAX) {
      const left = 'calc(100% - 12px)'
      fx('flash', {}, 400)
      fx('ring', { left }, 650)
      timers.push(setTimeout(() => fx('ring', { left }, 650), 120))
      for (let i = 0; i < 14; i++)
        fx(
          'spark',
          {
            left,
            '--a': `${(i * 360) / 14 + Math.random() * 12}deg`,
            '--d': `${22 + Math.random() * 22}px`,
          },
          600,
        )
      card.current?.classList.remove('effort-jolt')
      void card.current?.offsetWidth
      card.current?.classList.add('effort-jolt')
    }
    const embers = setInterval(
      () =>
        fx(
          'ember',
          {
            left: `${12 + Math.random() * (el.clientWidth - 40)}px`,
            '--x': `${Math.random() * 16 - 8}px`,
          },
          1250,
        ),
      140,
    )
    return () => {
      clearInterval(embers)
      timers.forEach(clearTimeout)
    }
  }, [index, max])

  const pos = (i: number) => `calc(12px + (100% - 24px) * ${i / MAX})`
  const fallbackAt = EFFORTS.findIndex((e) => e.id === effort.fallback)
  return (
    <div ref={card} className={cn('effort-card w-64 select-none', max && 'effort-max')}>
      <div className="flex h-5 items-center gap-1.5 text-sm">
        <span className="text-muted-foreground">Effort</span>
        <span key={index} className={cn('effort-name font-medium', max && 'effort-name-max')}>
          {EFFORTS[index]!.label}
          {/* Inside the name, right after its text: Safari can keep the box at the width
              of the level shown before, which pushed what came after it far off. */}
          {onDefault && (
            <span className="ml-1.5 inline-block rounded-full border px-1.5 align-[1px] text-[11px] font-normal text-muted-foreground">
              Default
            </span>
          )}
          {max && (
            <svg
              aria-hidden
              viewBox="0 0 12 14"
              className="effort-bolt ml-1 inline-block size-3.5 align-[-2px]"
            >
              <path d="M7 0 1 8h4l-1 6 6-8H6z" />
            </svg>
          )}
        </span>
        <button
          type="button"
          className={cn(
            'ml-auto rounded-full text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
            help && 'text-foreground',
          )}
          aria-label="What is effort?"
          aria-expanded={help}
          onClick={() => setHelp((h) => !h)}
        >
          <CircleHelp aria-hidden className="size-4" />
        </button>
      </div>
      {help && (
        <p className="effort-help mt-2 text-xs leading-relaxed text-muted-foreground">
          How hard teammates think before they answer. Higher is slower and uses more of your plan;
          lower is faster. Default is the model’s own level. It applies to every teammate in this
          thread, from its next turn.
        </p>
      )}
      <div className="mt-3 mb-1.5 flex justify-between text-xs text-muted-foreground">
        <span>Faster</span>
        <span className={cn(max && 'text-primary')}>Smarter</span>
      </div>
      <div
        ref={track}
        role="slider"
        tabIndex={0}
        aria-label="Effort"
        aria-valuemin={0}
        aria-valuemax={MAX}
        aria-valuenow={index}
        aria-valuetext={`${EFFORTS[index]!.label}${onDefault ? ' (default)' : ''}`}
        className="effort-track"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          setDragged(at(e.clientX))
        }}
        onPointerMove={(e) => {
          if (dragged !== undefined) setDragged(at(e.clientX))
        }}
        onPointerUp={(e) => pick(at(e.clientX))}
        onPointerCancel={() => setDragged(undefined)}
        onKeyDown={(e) => {
          const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key]
          const to =
            e.key === 'Home' ? 0 : e.key === 'End' ? MAX : step ? committed + step : undefined
          if (to === undefined) return
          // In the + menu, arrows would move between items or close the submenu.
          e.preventDefault()
          e.stopPropagation()
          pick(Math.min(MAX, Math.max(0, to)))
        }}
      >
        <div className="effort-fill" style={{ width: `calc(${pos(index)} + 10px)` }} />
        {EFFORTS.map((e, i) => (
          <div
            key={e.id}
            className="effort-notch"
            data-tick={i === fallbackAt || undefined}
            style={{ left: pos(i) }}
          />
        ))}
        <div
          className={cn('effort-handle', dragged !== undefined && 'effort-dragging')}
          style={{ left: pos(index) }}
        />
      </div>
      <div className="relative mt-1 h-4 text-xs text-muted-foreground">
        <span
          className={cn('absolute -translate-x-1/2', onDefault && 'text-foreground')}
          style={{ left: pos(fallbackAt) }}
        >
          Default
        </span>
      </div>
      {later && <p className="mt-2 text-xs text-muted-foreground">From the next turn</p>}
    </div>
  )
}

/** Next to send, off Default: the level's bars and name, opening the slider. */
export function EffortButton({
  effort,
  later,
  className,
}: {
  effort: EffortPick
  later?: boolean
  className?: string
}) {
  // Open, it stays while the slider goes back to Default; closed there, it goes.
  const [open, setOpen] = useState(false)
  if (!effortChanged(effort) && !open) return null
  const index = level(effort)
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Hint label={`${EFFORTS[index]!.label} effort${later ? ', from the next turn' : ''}`}>
        <Popover.Trigger asChild>
          <button
            type="button"
            className={cn(
              'flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent',
              index === MAX && 'bg-primary/10 text-primary hover:bg-primary/15',
              className,
            )}
          >
            <EffortBars index={index} />
            {EFFORTS[index]!.label}
          </button>
        </Popover.Trigger>
      </Hint>
      <EffortPanel effort={effort} later={later} align="end" />
    </Popover.Root>
  )
}

/** The slider over the composer, in a Popover.Root: from the button next to send. */
export function EffortPanel({
  effort,
  later,
  align,
}: {
  effort: EffortPick
  later?: boolean
  align: 'start' | 'end'
}) {
  return (
    <Popover.Portal>
      <Popover.Content
        side="top"
        align={align}
        sideOffset={6}
        className="z-50 origin-(--radix-popover-content-transform-origin) rounded-xl border bg-popover p-3.5 text-popover-foreground shadow-md data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
      >
        <EffortSlider effort={effort} {...(later ? { later } : {})} />
      </Popover.Content>
    </Popover.Portal>
  )
}
