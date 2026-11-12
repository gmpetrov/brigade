import Link from 'next/link'
import {
  CompareClose,
  CompareCta,
  CompareEyebrow,
  ComparePage,
  Logos,
} from '@/components/landing/compare'
import { c, Icon, type IconName } from '@/components/landing/parts'
import { BRIGADE, CHECKED, COMPARISONS } from '@/lib/compare'
import { pageMetadata, SITE_URL } from '@/lib/page-metadata'

export const dynamic = 'force-static'
export const revalidate = false

const title = 'Brigade alternatives and comparisons'
const description =
  'How Brigade compares with OpenClaw, Paperclip, Lindy, Sintra, Polsia, and Claude Code or Codex on their own: what each does, who pays for the AI, and when to pick which.'

export const metadata = pageMetadata('/compare', `${title} · Brigade`, description)

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'ItemList',
  name: title,
  itemListElement: COMPARISONS.map((x, i) => ({
    '@type': 'ListItem',
    position: i + 1,
    name: `Brigade vs ${x.name}`,
    url: `${SITE_URL}/compare/${x.slug}`,
  })),
}

/** What sets Brigade apart: all six at once. */
const STRENGTHS: { icon: IconName; title: string; text: string }[] = [
  {
    icon: 'users',
    title: 'The whole company',
    text: 'Support, marketing, sales and code, in one place.',
  },
  {
    icon: 'swap',
    title: 'A team in parallel',
    text: 'Many teammates at once, each with its own job.',
  },
  {
    icon: 'key',
    title: 'Your own AI plans',
    text: 'The official Claude Code and Codex on your Claude or ChatGPT login: no second AI bill.',
  },
  {
    icon: 'bell',
    title: 'You stay in control',
    text: 'You choose which App actions wait for your yes, and they all land in one list.',
  },
  {
    icon: 'phone',
    title: 'Ready to use',
    text: 'Hosted, on your phone with push notifications, with your team in the same threads.',
  },
  { icon: 'github', title: 'Open source', text: 'MIT, and free on your own computer.' },
]

export default function Compare() {
  return (
    <ComparePage>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }}
      />
      <header className={c('vs-hero')}>
        <CompareEyebrow checked={CHECKED} />
        <h1>How Brigade compares</h1>
        <p className={c('lead vs-answer')}>
          <strong>Brigade</strong> is {BRIGADE.what.charAt(0).toLowerCase() + BRIGADE.what.slice(1)}{' '}
          It runs on the Claude or ChatGPT plan you already pay for: Brigade never bills you for AI
          usage. It is free on your own computer, and Brigade Cloud is $99 a month per workspace.
        </p>
        <CompareCta />
      </header>

      <section className={c('vs-sec')} aria-labelledby="apart">
        <h2 id="apart">What sets Brigade apart: all six at once</h2>
        <ul className={c('vs-strengths')}>
          {STRENGTHS.map((s) => (
            <li key={s.title}>
              <span className={c('vs-strength-icon')}>
                <Icon name={s.icon} />
              </span>
              <strong>{s.title}</strong>
              <span>{s.text}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className={c('vs-sec')} aria-labelledby="list">
        <h2 id="list">Brigade vs…</h2>
        <ul className={c('vs-grid')}>
          {COMPARISONS.map((x) => (
            <li key={x.slug}>
              <Link className={c('vs-card')} href={`/compare/${x.slug}`}>
                <span className={c('vs-card-head')}>
                  <Logos logos={x.logos} />
                  <Icon name="arrow" />
                </span>
                <strong>Brigade vs {x.name}</strong>
                <span>{x.oneLiner}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <CompareClose title="See it for yourself" />
    </ComparePage>
  )
}
