'use client'
// What a thread shows while its messages load: the shape of a conversation, a
// light passing over it. Only once loading takes a moment, so a fast load does not
// flash; a slow one says so and offers to try again.
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/** Before this, nothing: most threads are in by then. */
const SHOW_AFTER = 300
/** After this, the connection looks slow: say so. */
const SLOW_AFTER = 4000

/** A placeholder bar: the shared Skeleton, as a pill with a shimmer instead of a pulse. */
function Bar({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <Skeleton
      aria-hidden
      className={cn('skeleton-shimmer h-[11px] animate-none rounded-full bg-secondary', className)}
      style={style}
    />
  )
}

/** A person's message: on the right, tinted like theirs. */
function Mine({ lines }: { lines: number[] }) {
  return (
    <div className="flex justify-end">
      <div className="flex w-[46%] flex-col gap-2.5 rounded-[1.4rem] bg-[color-mix(in_oklch,var(--primary)_10%,var(--secondary))] px-[18px] py-4">
        {lines.map((w, i) => (
          <Bar
            key={i}
            className="bg-[color-mix(in_oklch,var(--primary)_18%,var(--secondary))]"
            style={{ width: `${w}%` }}
          />
        ))}
      </div>
    </div>
  )
}

/** A teammate's message: avatar, who and when, a few lines. */
function Theirs({ lines }: { lines: number[] }) {
  return (
    <div className="flex items-start gap-3">
      <Bar className="mt-0.5 size-8 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-2.5 pt-1">
        <Bar className="mb-1 h-2.5 w-35" />
        {lines.map((w, i) => (
          <Bar key={i} style={{ width: `${w}%` }} />
        ))}
      </div>
    </div>
  )
}

export function ThreadSkeleton({
  since,
  onRetry,
}: {
  /** When loading started (Date.now()): the delays count from there, not from this mounting. */
  since: number
  onRetry?: () => void
}) {
  const [shown, setShown] = useState(() => Date.now() - since >= SHOW_AFTER)
  const [slow, setSlow] = useState(false)
  // Each retry gives the connection its time again before saying it is slow.
  const [retriedAt, setRetriedAt] = useState(since)
  useEffect(() => {
    const show = setTimeout(() => setShown(true), since + SHOW_AFTER - Date.now())
    return () => clearTimeout(show)
  }, [since])
  useEffect(() => {
    setSlow(false)
    const late = setTimeout(() => setSlow(true), retriedAt + SLOW_AFTER - Date.now())
    return () => clearTimeout(late)
  }, [retriedAt])
  if (!shown) return null
  return (
    <div
      role="status"
      aria-label="Loading the thread"
      data-thread-skeleton
      className="animate-in duration-300 fade-in motion-reduce:animate-none"
    >
      <div className="flex flex-col gap-7">
        <Mine lines={[78, 64]} />
        <Theirs lines={[92, 88, 71, 40]} />
        <Mine lines={[55]} />
        <Theirs lines={[90, 84, 60]} />
      </div>
      {slow && (
        <div className="mt-8 flex animate-in items-center justify-center gap-3 text-sm text-muted-foreground duration-300 fade-in motion-reduce:animate-none">
          Still loading. Your connection looks slow.
          {onRetry && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setRetriedAt(Date.now())
                onRetry()
              }}
            >
              Retry
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
