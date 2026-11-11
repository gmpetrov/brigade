import type { ReactNode } from 'react'
import { Footer } from '@/components/landing/closing'
import { Header } from '@/components/landing/hero'
import { c } from '@/components/landing/parts'

export const LEGAL_UPDATED = 'October 28, 2026'

/** A plain text page (privacy, terms) in the landing's header and footer. */
export function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <ArticlePage eyebrow={`Last updated ${LEGAL_UPDATED}`} title={title}>
      {children}
    </ArticlePage>
  )
}

/** A page of text (legal pages, comparisons) in the landing's header and footer. */
export function ArticlePage({
  eyebrow,
  title,
  children,
}: {
  eyebrow: ReactNode
  title: string
  children: ReactNode
}) {
  return (
    <div className={c('page')}>
      <Header />
      <main>
        <article className={c('legal')}>
          <div className={c('wrap')}>
            <p className={c('eyebrow')}>{eyebrow}</p>
            <h1>{title}</h1>
            {children}
          </div>
        </article>
      </main>
      <Footer />
    </div>
  )
}
