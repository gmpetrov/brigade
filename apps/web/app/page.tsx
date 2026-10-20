import type { Metadata } from 'next'
import { BuiltBy, Download, Faq, FinalCall, Footer, Pricing } from '@/components/landing/closing'
import { Control } from '@/components/landing/control'
import { Header, Hero, PlanBand } from '@/components/landing/hero'
import { Jobs } from '@/components/landing/jobs'
import { c } from '@/components/landing/parts'
import { Bridge, Message, Tiles } from '@/components/landing/sections'
import { RedirectIfSignedIn } from '@/components/redirect-if-signed-in'
import { getProofNumbers } from '@/lib/github-proof'

const SITE_URL = 'https://www.brigade.lol/'
const title = 'Brigade · The operating system for AI-native companies'
const description =
  'AI teammates that write your code, answer your customers, run your marketing and chase your leads, on the Claude or ChatGPT plan you already pay for. Free on your Mac, open source.'

// Static: prerendered at build, never revalidated. Its GitHub numbers are read at build
// too (next.config.ts, lib/github-proof.ts), so rendering it never calls GitHub.
export const dynamic = 'force-static'
export const revalidate = false

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: SITE_URL },
  openGraph: { type: 'website', url: SITE_URL, siteName: 'Brigade', title, description },
  twitter: { card: 'summary', title, description },
}

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'Brigade',
  url: SITE_URL,
  description,
  applicationCategory: 'BusinessApplication',
  operatingSystem: 'macOS, Web',
  offers: [
    { '@type': 'Offer', name: 'Free', price: '0', priceCurrency: 'USD' },
    {
      '@type': 'Offer',
      name: 'Cloud',
      price: '99',
      priceCurrency: 'USD',
      priceSpecification: {
        '@type': 'UnitPriceSpecification',
        price: '99',
        priceCurrency: 'USD',
        unitText: 'MONTH',
        billingDuration: 'P1M',
      },
    },
  ],
}

export default function Landing() {
  const numbers = getProofNumbers()
  return (
    <div className={c('page')}>
      <RedirectIfSignedIn />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }}
      />
      <Header />
      <main>
        <Hero />
        <PlanBand />
        <Message />
        <Bridge />
        <Tiles />
        <Jobs />
        <Control />
        <BuiltBy numbers={numbers} />
        <Pricing />
        <Download />
        <Faq />
        <FinalCall />
      </main>
      <Footer />
    </div>
  )
}
