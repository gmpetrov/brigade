import Link from 'next/link'
import { ArticlePage } from '@/components/landing/legal'
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

export default function Compare() {
  return (
    <ArticlePage eyebrow={`Checked ${CHECKED}`} title={title}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }}
      />
      <p>
        <strong>Brigade</strong> is {BRIGADE.what.charAt(0).toLowerCase() + BRIGADE.what.slice(1)}{' '}
        It runs on the Claude or ChatGPT plan you already pay for: Brigade never bills you for AI
        usage. It is free on your own computer, and Brigade Cloud is $99 a month per workspace.
      </p>
      <p>What sets it apart is doing all six of these at once:</p>
      <ul>
        <li>
          <strong>The whole company:</strong> support, marketing, sales and code, in one place.
        </li>
        <li>
          <strong>A team in parallel:</strong> many teammates at once, each with its own job.
        </li>
        <li>
          <strong>Your own AI plans:</strong> the official Claude Code and Codex on your Claude or
          ChatGPT login, so no second AI bill.
        </li>
        <li>
          <strong>You stay in control:</strong> you choose what waits for your yes, and it all lands
          in one list.
        </li>
        <li>
          <strong>Ready to use:</strong> hosted, on your phone with push notifications, with your
          team in the same threads.
        </li>
        <li>
          <strong>Open source:</strong> MIT, free on your own computer.
        </li>
      </ul>
      <h2>Comparisons</h2>
      <ul>
        {COMPARISONS.map((x) => (
          <li key={x.slug}>
            <Link href={`/compare/${x.slug}`}>Brigade vs {x.name}</Link>: {x.oneLiner}
          </li>
        ))}
      </ul>
    </ArticlePage>
  )
}
