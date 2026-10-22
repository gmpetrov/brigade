'use client'
import { MousePointer2, RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { DEMO } from '@/lib/demo/flag'
import { play, Stopped, TOUR_PARAM } from '@/lib/demo/tour'

/**
 * The demo's walkthrough (lib/demo/tour.ts), on demo.brigade.lol/app?tour: the landing page's
 * frame opens it. It starts once the frame is in view, stops at the visitor's first click, key
 * or scroll, and then offers to play it again.
 */
export function DemoTour() {
  const cursor = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'off' | 'waiting' | 'playing' | 'yours'>('off')

  useEffect(() => {
    if (!DEMO || !new URLSearchParams(location.search).has(TOUR_PARAM)) return
    setState('waiting')
    const abort = new AbortController()
    const kinds = ['pointerdown', 'keydown', 'wheel', 'touchstart']
    let observer: IntersectionObserver | undefined
    let restore: (() => void) | undefined
    // However it ends (the visitor, the walkthrough done, the page left): nothing of it stays.
    const end = () => {
      observer?.disconnect()
      restore?.()
      restore = undefined
      for (const kind of kinds) window.removeEventListener(kind, takeOver, { capture: true })
    }
    // A person's own input ends it, also before it started: events the tour makes are not trusted.
    const takeOver = (e: Event) => {
      if (!e.isTrusted || abort.signal.aborted) return
      abort.abort()
      end()
      setState((was) => (was === 'waiting' ? 'off' : 'yours'))
    }
    for (const kind of kinds)
      window.addEventListener(kind, takeOver, { capture: true, passive: true })

    const start = () => {
      observer?.disconnect()
      if (abort.signal.aborted || !cursor.current) return
      // The merge asks to confirm: the tour says yes, only while it plays.
      const confirm = window.confirm
      window.confirm = () => true
      restore = () => (window.confirm = confirm)
      setState('playing')
      play({ signal: abort.signal, cursor: cursor.current })
        .catch((e) => {
          if (!(e instanceof Stopped)) console.error(e)
        })
        .finally(() => {
          end()
          setState('yours')
        })
    }
    // In the landing page's frame, once most of it shows (the frame's view is the page's).
    observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.intersectionRatio >= 0.35)) start()
      },
      { threshold: [0, 0.35, 0.6] },
    )
    observer.observe(document.documentElement)
    return () => {
      abort.abort()
      end()
    }
  }, [])

  if (state === 'off') return null
  return (
    <>
      <div
        ref={cursor}
        hidden={state !== 'playing'}
        aria-hidden
        className="pointer-events-none fixed top-0 left-0 z-[2147483647] transition-transform duration-700 ease-[cubic-bezier(0.22,1,0.36,1)] data-[pressed]:scale-90 motion-reduce:transition-none"
        style={{ transform: 'translate(55vw, 60vh)' }}
      >
        <MousePointer2 className="fill-primary text-primary-foreground size-6 -translate-x-1 -translate-y-1 drop-shadow-md" />
        <span className="bg-primary text-primary-foreground ml-4 rounded-full px-2 py-0.5 text-xs font-semibold shadow-md">
          You
        </span>
      </div>
      {state === 'yours' && (
        // In the brand's violet, so it shows at once; above the message box, not over its send button.
        <div className="bg-primary text-primary-foreground fixed right-4 bottom-24 z-50 flex items-center gap-2 rounded-full py-1.5 pr-1.5 pl-4 text-sm shadow-lg">
          <span className="font-semibold">Your turn</span>
          <span className="opacity-80">click around</span>
          <button
            type="button"
            // From the start, Home: a reload anywhere else would replay from where it ended.
            onClick={() => location.assign(`/app?${TOUR_PARAM}`)}
            className="ml-1 inline-flex items-center gap-1.5 rounded-full bg-white/20 px-3 py-1 font-semibold transition-colors hover:bg-white/30"
          >
            <RotateCcw className="size-3.5" aria-hidden />
            Replay
          </button>
        </div>
      )}
    </>
  )
}
