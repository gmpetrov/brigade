'use client'
import { ArrowRight } from 'lucide-react'
import { DEMO, SIGN_UP_URL } from '@/lib/demo/flag'

/**
 * The demo's sign (demo.brigade.lol, lib/demo/flag.ts): floating at the top right of every
 * page, so a visitor always knows the workspace is a sample and where to start for real.
 */
export function DemoBanner() {
  if (!DEMO) return null
  return (
    <div className="bg-card/95 fixed top-3 right-3 z-50 flex items-center gap-3 rounded-full border py-1 pr-1 pl-3.5 text-sm shadow-md backdrop-blur">
      <span className="flex items-center gap-2">
        <span aria-hidden className="bg-primary size-2 rounded-full" />
        <span className="font-medium">Demo workspace</span>
        <span className="text-muted-foreground hidden lg:inline">
          Click around, nothing is real
        </span>
      </span>
      <a
        href={SIGN_UP_URL}
        className="bg-primary text-primary-foreground inline-flex h-7 items-center gap-1 rounded-full px-3 font-semibold transition-opacity hover:opacity-90"
      >
        <span className="hidden sm:inline">Start free on your Mac</span>
        <span className="sm:hidden">Start free</span>
        <ArrowRight className="size-3.5" aria-hidden />
      </a>
    </div>
  )
}
