import { notFound } from 'next/navigation'
import {
  CompareClose,
  CompareCta,
  CompareEyebrow,
  ComparePage,
  Logos,
  LogoTile,
  MarkIcon,
} from '@/components/landing/compare'
import { c, Icon } from '@/components/landing/parts'
import { CHECKED, COMPARISONS, findComparison } from '@/lib/compare'
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
    <ComparePage>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }}
      />
      <header className={c('vs-hero')}>
        <CompareEyebrow checked={CHECKED} back />
        <div className={c('vs-pair')} aria-hidden="true">
          <LogoTile logo="brigade" />
          <span>vs</span>
          <Logos logos={x.logos} />
        </div>
        <h1>{heading(x.name)}</h1>
        <p className={c('lead vs-answer')}>{x.answer}</p>
        <CompareCta label="Start now" />
      </header>

      <section className={c('vs-sec')} aria-labelledby="side-by-side">
        <h2 id="side-by-side">Side by side</h2>
        <div className={c('vs-scroll')}>
          <table className={c('vs-table')}>
            <thead>
              <tr>
                <th scope="col">
                  <span className={c('sr-only')}>Feature</span>
                </th>
                <th scope="col" className={c('vs-us')}>
                  <span className={c('vs-col')}>
                    <LogoTile logo="brigade" size="sm" />
                    Brigade
                  </span>
                </th>
                <th scope="col">
                  <span className={c('vs-col')}>
                    <Logos logos={x.logos} size="sm" />
                    {x.name}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {x.rows.map((r) => (
                <tr key={r.label}>
                  <th scope="row">{r.label}</th>
                  <td className={c('vs-us')}>
                    <span className={c('vs-cell')}>
                      {r.mark && <MarkIcon mark="yes" />}
                      <span>{r.brigade}</span>
                    </span>
                  </td>
                  <td>
                    <span className={c('vs-cell')}>
                      {r.mark && <MarkIcon mark={r.mark} />}
                      <span>{r.them}</span>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className={c('vs-sec')} aria-labelledby="which">
        <h2 id="which">Which one is for you</h2>
        <div className={c('vs-picks')}>
          <div className={c('vs-pick us')}>
            <h3>
              <LogoTile logo="brigade" size="sm" />
              Pick Brigade if
            </h3>
            <ul>
              {x.pickBrigade.map((line) => (
                <li key={line}>
                  <Icon name="check" />
                  {line}
                </li>
              ))}
            </ul>
          </div>
          <div className={c('vs-pick')}>
            <h3>
              <Logos logos={x.logos} size="sm" />
              Pick {x.name} if
            </h3>
            <ul>
              {x.pickThem.map((line) => (
                <li key={line}>
                  <Icon name="x" />
                  {line}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className={c('vs-sec vs-about')} aria-labelledby="about">
        <h2 id="about">What {x.name} is</h2>
        <p>{x.about}</p>
      </section>

      <CompareClose title="Meet your AI teammates" />

      <details className={c('vs-sources')}>
        <summary>
          Sources, checked on {CHECKED}
          <Icon name="arrow" />
        </summary>
        <p>
          What this page says about {x.name} comes from these pages. Products change: if something
          here is out of date, open an issue on <a href={REPO_URL}>GitHub</a>.
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
      </details>
    </ComparePage>
  )
}
