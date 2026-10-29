import Link from 'next/link'
import { notFound } from 'next/navigation'
import { changelogMetadata } from '@/components/landing/changelog'
import { Footer } from '@/components/landing/closing'
import { Header } from '@/components/landing/hero'
import { c } from '@/components/landing/parts'
import { REPO_URL } from '@/lib/github-proof'
import { findRelease, RELEASES, releaseDate } from '@/lib/changelog'

type Props = { params: Promise<{ slug: string }> }

export const dynamicParams = false

export function generateStaticParams() {
  return RELEASES.map((r) => ({ slug: r.slug }))
}

export async function generateMetadata({ params }: Props) {
  const release = findRelease((await params).slug)
  if (!release) return {}
  return changelogMetadata(
    `/changelog/${release.slug}`,
    `${release.title} · Brigade changelog`,
    release.summary,
  )
}

export default async function Release({ params }: Props) {
  const release = findRelease((await params).slug)
  if (!release) notFound()
  return (
    <div className={c('page')}>
      <Header />
      <main>
        <article className={c('log release')} aria-labelledby="release-title">
          <div className={c('wrap')}>
            <Link className={c('log-back')} href="/changelog">
              ← All releases
            </Link>
            <p className={c('eyebrow')}>
              <time dateTime={release.slug}>{releaseDate(release.slug)}</time>
            </p>
            <h1 id="release-title">{release.title}</h1>
            <p className={c('log-lead')}>{release.summary}</p>
            {release.sections.map((section) => (
              <section key={section.heading}>
                <h2>{section.heading}</h2>
                <ul>
                  {section.items.map((item) => (
                    <li key={item.title}>
                      <strong>{item.title}.</strong> {item.text}
                      {item.prs?.length ? (
                        <span className={c('log-prs')}>
                          {item.prs.map((n) => (
                            <a key={n} href={`${REPO_URL}/pull/${n}`}>
                              #{n}
                            </a>
                          ))}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </article>
      </main>
      <Footer />
    </div>
  )
}
