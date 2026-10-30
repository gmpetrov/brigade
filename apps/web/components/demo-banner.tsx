'use client'
import { ArrowRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import { DEMO, framed, SIGN_UP_URL } from '@/lib/demo/flag'
import { Hint } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/**
 * The demo's sign (demo.brigade.lol, lib/demo/flag.ts), so a visitor always knows the
 * workspace is a sample and where to start for real: a card at the foot of the sidebar,
 * a round button there when it is folded to icons, and a strip atop the page on a phone.
 */
export function DemoBanner({ place }: { place: 'sidebar' | 'phone' }) {
  // In the landing page's frame, the page around it is the sign.
  const [inFrame, setInFrame] = useState(false)
  useEffect(() => setInFrame(framed()), [])
  if (!DEMO || inFrame) return null
  if (place === 'phone')
    return (
      <div className="bg-primary text-primary-foreground flex items-center justify-between gap-3 px-4 py-2 text-sm md:hidden">
        <span className="font-medium">Demo workspace</span>
        <a
          href={SIGN_UP_URL}
          target="_top"
          className="inline-flex items-center gap-1 font-semibold underline-offset-2 hover:underline"
        >
          Sign up free
          <ArrowRight className="size-3.5" aria-hidden />
        </a>
      </div>
    )
  return (
    <div className="mx-2 group-data-[collapsible=icon]:mx-0">
      <div className="bg-card rounded-lg border p-3 text-sm group-data-[collapsible=icon]:hidden">
        <p className="flex items-center gap-2 font-semibold">
          <span aria-hidden className="bg-primary size-2 rounded-full" />
          Demo workspace
        </p>
        <p className="text-muted-foreground mt-1 text-[0.8125rem] leading-snug">
          Acme is a sample. Click around: approve, merge, write to a teammate. Nothing here is real.
        </p>
        <a
          href={SIGN_UP_URL}
          target="_top"
          className={cn(
            'bg-primary text-primary-foreground mt-2.5 flex h-8 items-center justify-center gap-1 rounded-full px-3 font-semibold transition-opacity hover:opacity-90',
          )}
        >
          Sign up free
          <ArrowRight className="size-3.5" aria-hidden />
        </a>
      </div>
      <Hint side="right" label="Demo workspace: sign up free">
        <a
          href={SIGN_UP_URL}
          target="_top"
          aria-label="Demo workspace: sign up free"
          className="bg-primary text-primary-foreground hidden size-8 items-center justify-center rounded-full group-data-[collapsible=icon]:flex"
        >
          <ArrowRight className="size-4" aria-hidden />
        </a>
      </Hint>
    </div>
  )
}
