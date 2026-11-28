import Link from 'next/link'
import { notFound } from 'next/navigation'
import { changelogMetadata } from '@/components/landing/changelog'
import { SitePage } from '@/components/home/site-page'
import { c } from '@/components/landing/parts'
import { REPO_URL } from '@/lib/github-proof'
import { fitDescription, SITE_URL } from '@/lib/page-metadata'
import { findRelease, releaseName, RELEASES, releaseDate } from '@/lib/changelog'

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
    pageTitle(releaseName(release)),
    release.summary,
  )
}

/** "<title> · Brigade changelog", or "<title> · Brigade" when that would run past 60 characters. */
const pageTitle = (title: string) =>
  `${title} · Brigade changelog`.length <= 60
    ? `${title} · Brigade changelog`
    : `${title} · Brigade`

export default async function Release({ params }: Props) {
  const release = findRelease((await params).slug)
  if (!release) notFound()
  // RELEASES runs newest first.
  const at = RELEASES.indexOf(release)
  const newer = RELEASES[at - 1]
  const older = RELEASES[at + 1]
  const url = `${SITE_URL}/changelog/${release.slug}`
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: releaseName(release),
    description: fitDescription(release.summary),
    url,
    mainEntityOfPage: url,
    image: `${SITE_URL}/opengraph-image.png`,
    datePublished: release.slug,
    author: { '@id': `${SITE_URL}/#organization` },
    publisher: {
      '@type': 'Organization',
      '@id': `${SITE_URL}/#organization`,
      name: 'Brigade',
      url: `${SITE_URL}/`,
      logo: `${SITE_URL}/icon.png`,
    },
  }
  return (
    <SitePage>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }}
      />
      <article className={c('log release')} aria-labelledby="release-title">
        <div className={c('wrap')}>
          <Link className={c('log-back')} href="/changelog">
            ← All releases
          </Link>
          <p className={c('eyebrow')}>
            {release.version && <>v{release.version} · </>}
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
          <nav className={c('log-pager')} aria-label="Other releases">
            {older ? (
              <Link href={`/changelog/${older.slug}`} rel="prev">
                <span>← Older</span>
                {older.title}
              </Link>
            ) : (
              <span />
            )}
            {newer && (
              <Link href={`/changelog/${newer.slug}`} rel="next">
                <span>Newer →</span>
                {newer.title}
              </Link>
            )}
          </nav>
        </div>
      </article>
    </SitePage>
  )
}
