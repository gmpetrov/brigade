import type { Metadata } from 'next'
import { Apps } from '@/components/landing/apps'
import { BuiltBy, FAQ, Faq, FinalCall, Footer, Pricing } from '@/components/landing/closing'
import { Control } from '@/components/landing/control'
import { Header, Hero } from '@/components/landing/hero'
import { Jobs } from '@/components/landing/jobs'
import { LiveDemo } from '@/components/landing/live-demo'
import { PauseOffscreen } from '@/components/landing/in-view'
import { c } from '@/components/landing/parts'
import { Plans } from '@/components/landing/plans'
import { Tiles } from '@/components/landing/sections'
import { RedirectIfSignedIn } from '@/components/redirect-if-signed-in'
import { getProofNumbers, REPO_URL } from '@/lib/github-proof'
import { pageMetadata, SITE_URL } from '@/lib/page-metadata'

const title = 'Brigade · AI teammates that run your whole company'
const description =
  'AI teammates that write your code, answer your customers, run your marketing and chase your leads, on the Claude or ChatGPT plan you already pay for. Free on your own computer, open source.'

// Static: prerendered at build, never revalidated. Its GitHub numbers are read at build
// too (next.config.ts, lib/github-proof.ts), so rendering it never calls GitHub.
export const dynamic = 'force-static'
export const revalidate = false

export const metadata: Metadata = pageMetadata('/', title, description)

// What the page is about, for search engines and AI assistants: the product, who makes it
// and the questions it answers (the FAQ below, word for word).
const ORG_ID = `${SITE_URL}/#organization`
const jsonLd = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'Organization',
      '@id': ORG_ID,
      name: 'Brigade',
      url: `${SITE_URL}/`,
      logo: `${SITE_URL}/icon.png`,
      sameAs: [REPO_URL],
    },
    {
      '@type': 'WebSite',
      '@id': `${SITE_URL}/#website`,
      name: 'Brigade',
      url: `${SITE_URL}/`,
      publisher: { '@id': ORG_ID },
    },
    {
      '@type': 'SoftwareApplication',
      name: 'Brigade',
      alternateName: 'Brigade AI teammates',
      url: `${SITE_URL}/`,
      description,
      applicationCategory: 'BusinessApplication',
      applicationSubCategory: 'AI agents',
      operatingSystem: 'macOS, Linux, Web',
      isAccessibleForFree: true,
      license: 'https://opensource.org/licenses/MIT',
      softwareHelp: { '@type': 'WebPage', url: `${SITE_URL}/docs` },
      sameAs: [REPO_URL, 'https://demo.brigade.lol'],
      publisher: { '@id': ORG_ID },
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
    },
    {
      '@type': 'FAQPage',
      mainEntity: FAQ.map(({ q, a }) => ({
        '@type': 'Question',
        name: q,
        acceptedAnswer: { '@type': 'Answer', text: a },
      })),
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
        <LiveDemo />
        <Plans />
        <Apps />
        <Tiles />
        <Jobs />
        <Control />
        <BuiltBy numbers={numbers} />
        <Pricing />
        <Faq />
        <FinalCall />
      </main>
      <Footer />
      <PauseOffscreen />
    </div>
  )
}
