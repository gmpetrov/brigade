'use client'
import { RotateCw } from 'lucide-react'
import { useEffect, useState } from 'react'
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
 * "New version" floating at the top of the page, once a newer build is deployed than
 * the one this page runs: under the header when there is one (`header`, and the top bar
 * on phones). Pressing it reloads. Not in development, where pages reload by themselves.
 */
export function UpdatePill({ header }: { header: boolean }) {
  const [behind, setBehind] = useState(false)
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
  if (!behind) return null
  return (
    // h-0 and sticky: it takes no room and stays in sight as the page scrolls.
    <div className="pointer-events-none sticky top-0 z-40 flex h-0 justify-center">
      <button
        type="button"
        onClick={() => window.location.reload()}
        className={cn(
          'bg-primary-solid text-primary-foreground animate-in fade-in slide-in-from-top-2 pointer-events-auto mt-14 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-sm font-semibold shadow-md transition-opacity hover:opacity-90',
          !header && 'md:mt-3',
        )}
      >
        <RotateCw className="size-3.5" aria-hidden />
        New version
      </button>
    </div>
  )
}
