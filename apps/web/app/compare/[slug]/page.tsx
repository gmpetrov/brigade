import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArticlePage } from '@/components/landing/legal'
import { c } from '@/components/landing/parts'
import { BRIGADE_LIMITS, CHECKED, COMPARISONS, findComparison } from '@/lib/compare'
import { REPO_URL } from '@/lib/github-proof'
import { pageMetadata, SITE_URL } from '@/lib/page-metadata'

type Props = { params: Promise<{ slug: string }> }

export const dynamicParams = false

export function generateStaticParams() {
  return COMPARISONS.map((x) => ({ slug: x.slug }))
}

const heading = (name: string) => `Brigade vs ${name}`

export async function generateMetadata({ params }: Props) {
  const x = findComparison((await params).slug)
  if (!x) return {}
  return pageMetadata(`/compare/${x.slug}`, `${heading(x.name)} · Brigade`, x.oneLiner)
}

export default async function Comparison({ params }: Props) {
  const x = findComparison((await params).slug)
  if (!x) notFound()
  const url = `${SITE_URL}/compare/${x.slug}`
  // The page's answers, for search engines that read questions and answers.
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    url,
    mainEntity: [
      { q: `What is the difference between Brigade and ${x.name}?`, a: x.answer },
      { q: `When should I pick ${x.name}?`, a: x.pickThem.join(' ') },
      { q: 'When should I pick Brigade?', a: x.pickBrigade.join(' ') },
    ].map(({ q, a }) => ({
      '@type': 'Question',
      name: q,
      acceptedAnswer: { '@type': 'Answer', text: a },
    })),
  }
  return (
    <ArticlePage
      eyebrow={
        <>
          <Link href="/compare">Comparisons</Link> · Checked {CHECKED}
        </>
      }
      title={heading(x.name)}
    >
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }}
      />
      <p>{x.answer}</p>

      <h2>What {x.name} is</h2>
      <p>{x.about}</p>

      <h2>Side by side</h2>
      <div className={c('cmp-scroll')}>
        <table className={c('cmp')}>
          <thead>
            <tr>
              <th scope="col" />
              <th scope="col">Brigade</th>
              <th scope="col">{x.name}</th>
            </tr>
          </thead>
          <tbody>
            {x.rows.map((r) => (
              <tr key={r.label}>
                <th scope="row">{r.label}</th>
                <td>{r.brigade}</td>
                <td>{r.them}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Pick {x.name} if</h2>
      <ul>
        {x.pickThem.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>

      <h2>Pick Brigade if</h2>
      <ul>
        {x.pickBrigade.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>

      <h2>Where Brigade is weaker</h2>
      <ul>
        {BRIGADE_LIMITS.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>

      <h2>Try it</h2>
      <p>
        Click around the <a href="https://demo.brigade.lol">live demo</a> (no sign-up), read the{' '}
        <a href="/docs">docs</a>, or read the code on <a href={REPO_URL}>GitHub</a>.
      </p>

      <h2>Sources</h2>
      <p>
        What this page says about {x.name} comes from these pages, checked on {CHECKED}. Products
        change: if something here is out of date, open an issue on{' '}
        <a href={REPO_URL}>GitHub</a>.
      </p>
      <ul>
        {x.sources.map((s) => (
          <li key={s.url}>
            <a href={s.url} rel="nofollow">
              {s.label}
            </a>
          </li>
        ))}
      </ul>
    </ArticlePage>
  )
}
