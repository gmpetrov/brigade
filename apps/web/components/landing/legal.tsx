import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { Footer } from '@/components/landing/closing'
import { Header } from '@/components/landing/hero'
import { c } from '@/components/landing/parts'

export const LEGAL_UPDATED = 'October 28, 2026'

export function legalMetadata(path: string, title: string, description: string): Metadata {
  const url = `https://www.brigade.lol${path}`
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { type: 'website', url, siteName: 'Brigade', title, description },
    twitter: { card: 'summary', title, description },
  }
}

/** A plain text page (privacy, terms) in the landing's header and footer. */
export function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={c('page')}>
      <Header />
      <main>
        <article className={c('legal')}>
          <div className={c('wrap')}>
            <p className={c('eyebrow')}>Last updated {LEGAL_UPDATED}</p>
            <h1>{title}</h1>
            {children}
          </div>
        </article>
      </main>
      <Footer />
    </div>
  )
}
