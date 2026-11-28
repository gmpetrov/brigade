import type { ReactNode } from 'react'
import { Footer } from '@/components/landing/closing'
import { PauseOffscreen, Reveal } from '@/components/landing/in-view'
import { c } from '@/components/landing/parts'
import { Header } from './hero'
import { h } from './parts'

/**
 * A public page in the landing's frame: its bar on top, and the page as a sheet over the
 * footer, which waits underneath and is uncovered by scrolling to the end (home.module.css,
 * .sheet and .under). Every public page (landing, pricing, changelog, compare, guides, legal)
 * uses it, so they all share one header and one footer.
 *
 * `hero` sits in the sheet above the landing's own sections (components/landing), which take
 * `children`, in their wrapper for their spacing and scale; `className` adds to that wrapper.
 */
export function SitePage({
  hero,
  className,
  children,
}: {
  hero?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <div className={h('page')}>
      <Header />
      <main className={h('sheet')}>
        {hero}
        <div className={className ? `${c('page')} ${c(className)}` : c('page')}>{children}</div>
      </main>
      <div className={`${c('page')} ${h('under')}`}>
        <Footer carved />
      </div>
      <PauseOffscreen />
      <Reveal />
    </div>
  )
}
