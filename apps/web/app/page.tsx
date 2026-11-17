import type { Metadata } from 'next'
import { Apps } from '@/components/landing/apps'
import { BuiltBy, FAQ, Faq, FinalCall, Footer } from '@/components/landing/closing'
// Hidden for now, to shorten the page; uncomment here and below to bring it back.
// import { Control } from '@/components/landing/control'
import { Header, Hero } from '@/components/landing/hero'
import { LiveDemo } from '@/components/landing/live-demo'
import { PauseOffscreen } from '@/components/landing/in-view'
import { c } from '@/components/landing/parts'
import { Plans } from '@/components/landing/plans'
import { Tiles } from '@/components/landing/sections'
import { RedirectIfSignedIn } from '@/components/redirect-if-signed-in'
import { DEMO_URL } from '@/lib/demo/flag'
import { getProofNumbers, REPO_URL } from '@/lib/github-proof'
import { pageMetadata, SITE_URL } from '@/lib/page-metadata'

const title = 'Brigade · AI teammates that run your whole company'
const description =
  'AI teammates that code, answer customers, run marketing and chase leads on the Claude or ChatGPT plan you already pay for. Open source, free on your computer.'

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
      // Other open-source projects are named Brigade: say which one this is.
      disambiguatingDescription:
        'Brigade at brigade.lol (github.com/gmpetrov/brigade): AI teammates for support, marketing, sales and code that run on your own Claude or ChatGPT plan.',
      operatingSystem: 'macOS, Linux, Web',
      isAccessibleForFree: true,
      license: 'https://opensource.org/licenses/MIT',
      softwareHelp: { '@type': 'WebPage', url: `${SITE_URL}/docs` },
      sameAs: [REPO_URL, `${DEMO_URL}/app`],
      publisher: { '@id': ORG_ID },
      offers: [
        { '@type': 'Offer', name: 'Free', price: '0', priceCurrency: 'USD' },
        {
          '@type': 'Offer',
          name: 'Starter',
          price: '15',
          priceCurrency: 'USD',
          priceSpecification: {
            '@type': 'UnitPriceSpecification',
            price: '15',
            priceCurrency: 'USD',
            unitText: 'MONTH',
            billingDuration: 'P1M',
          },
        },
        {
          '@type': 'Offer',
          name: 'Max',
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
        {/* "Hand off the work. Keep the decisions." Hidden for now, to shorten the page. */}
        {/* <Control /> */}
        <BuiltBy numbers={numbers} />
        <Faq />
        <FinalCall />
      </main>
      <Footer featured />
      <PauseOffscreen />
    </div>
  )
}
