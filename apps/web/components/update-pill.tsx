'use client'
import { LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { buildAssets } from '@/lib/build-assets'
import { cn } from '@/lib/utils'

const BUILD = process.env.NEXT_PUBLIC_BUILD_ID
// How often an open dashboard asks which build the server runs; also when it comes back
// into view, where a dashboard left open for days most often learns of one.
const EVERY = 5 * 60_000

/** Whether the server runs a newer build than this page; false when it can't tell. */
export async function newerBuild() {
  if (!BUILD || process.env.NODE_ENV === 'development') return false
  try {
    const res = await fetch('/version', { cache: 'no-store' })
    if (!res.ok) return false
    const { build } = (await res.json()) as { build?: string }
    return !!build && build !== BUILD
  } catch {
    // Offline or deploying: ask again later.
    return false
  }
}

/**
 * Fetches, at low priority, the build files the page at this address loads in the new
 * build, so the reload onto it finds them in the browser's cache (they are kept for a
 * year: public/_headers) and only waits for the page and its data. It also wakes the
 * server that renders it. Best effort: anything that fails is simply fetched on reload.
 */
async function warmNewBuild() {
  try {
    const res = await fetch(window.location.href, { cache: 'no-store', priority: 'low' })
    if (!res.ok) return
    for (const href of buildAssets(await res.text())) {
      const link = document.createElement('link')
      link.rel = 'prefetch'
      link.href = href
      document.head.appendChild(link)
    }
  } catch {
    // Offline or deploying: the reload fetches them.
  }
}

/**
 * "New version ready" floating at the top of the page, once a newer build is deployed
 * than the one this page runs: under the header when there is one (`header`, and the top
 * bar on phones). The new build's files are fetched ahead as soon as it is known; pressing
 * it reloads, and shows so at once (a spinner, a bar along the top, the page fading), since
 * the old page otherwise stays as it was until the new one arrives. Not in development,
 * where pages reload by themselves.
 */
export function UpdatePill({ header }: { header: boolean }) {
  const [behind, setBehind] = useState(false)
  const [reloading, setReloading] = useState(false)
  useEffect(() => {
    if (!BUILD || process.env.NODE_ENV === 'development' || behind) return
    const check = async () => {
      if (document.visibilityState !== 'visible') return
      if (await newerBuild()) setBehind(true)
    }
    const timer = setInterval(check, EVERY)
    document.addEventListener('visibilitychange', check)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', check)
    }
  }, [behind])
  useEffect(() => {
    if (behind) void warmNewBuild()
  }, [behind])
  // Back on this page from the browser's back-forward cache: it is no longer reloading.
  useEffect(() => {
    const shown = (e: PageTransitionEvent) => e.persisted && setReloading(false)
    window.addEventListener('pageshow', shown)
    return () => window.removeEventListener('pageshow', shown)
  }, [])
  if (!behind) return null
  const reload = () => {
    setReloading(true)
    // A frame to paint the spinner first: the reload can hold the page from then on.
    requestAnimationFrame(() => setTimeout(() => window.location.reload(), 0))
  }
  return (
    <>
      {reloading && (
        <>
          <div
            aria-hidden
            className="bg-background/60 animate-in fade-in fixed inset-0 z-50 delay-150 duration-300 fill-mode-backwards"
          />
          <div
            aria-hidden
            className="update-progress bg-primary fixed inset-x-0 top-0 z-50 h-0.5 origin-left"
          />
        </>
      )}
      {/* h-0 and sticky: it takes no room and stays in sight as the page scrolls. */}
      <div className="pointer-events-none sticky top-0 z-50 flex h-0 justify-center">
        <button
          type="button"
          onClick={reload}
          disabled={reloading}
          aria-live="polite"
          className={cn(
            'bg-card text-foreground border-border animate-in fade-in slide-in-from-top-2 pointer-events-auto mt-14 inline-flex h-8 shrink-0 items-center gap-2 rounded-full border py-1 pr-1 pl-3 text-sm font-medium shadow-lg transition-colors disabled:cursor-default',
            'hover:[&>span:last-child]:opacity-90',
            !header && 'md:mt-3',
          )}
        >
          {reloading ? (
            <>
              <LoaderCircle className="text-primary size-3.5 animate-spin" aria-hidden />
              <span className="pr-2">Updating…</span>
            </>
          ) : (
            <>
              <span className="bg-primary size-1.5 rounded-full" aria-hidden />
              New version ready
              <span className="bg-primary text-primary-foreground inline-flex h-6 items-center rounded-full px-2.5 text-xs font-semibold transition-opacity">
                Reload
              </span>
            </>
          )}
        </button>
      </div>
    </>
  )
}
