import type { Metadata } from 'next'
import { AuthLink } from '@/components/landing/auth-link'
import { Footer } from '@/components/landing/closing'
import { Header } from '@/components/landing/hero'
import { c, SIGN_UP } from '@/components/landing/parts'
import { UnderTheHood } from '@/components/landing/under-the-hood'

const URL = 'https://www.brigade.lol/how-it-works'
const title = 'How Brigade works'
const description =
  'Brigade runs the real Claude Code and Codex on your own plans, stacks several accounts, moves threads between your Mac and the cloud, and gives every teammate computer use.'

export const dynamic = 'force-static'
export const revalidate = false

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: URL },
  openGraph: { type: 'website', url: URL, siteName: 'Brigade', title, description },
  twitter: { card: 'summary', title, description },
}

export default function HowItWorks() {
  return (
    <div className={c('page')}>
      <Header />
      <main>
        <section className={c('hiw')} aria-labelledby="hiw-title">
          <div className={c('wrap')}>
            <p className={c('eyebrow')}>Under the hood</p>
            <h1 id="hiw-title">How Brigade works</h1>
            <p className={c('lead')}>
              Your teammates run on the same agents you would run in a terminal, on the plans you
              already pay for, on your Mac or Brigade&apos;s cloud computer.
            </p>
            <AuthLink className={c('btn pri lg')} href={SIGN_UP}>
              Sign up
            </AuthLink>
          </div>
        </section>
        <UnderTheHood />
      </main>
      <Footer />
    </div>
  )
}
