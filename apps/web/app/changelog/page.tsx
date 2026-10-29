import Link from 'next/link'
import { Footer } from '@/components/landing/closing'
import { Header } from '@/components/landing/hero'
import { c, Icon } from '@/components/landing/parts'
import { changelogMetadata, FEED_PATH } from '@/components/landing/changelog'
import { RELEASES, releaseDate } from '@/lib/changelog'

export const dynamic = 'force-static'
export const revalidate = false

export const metadata = changelogMetadata(
  '/changelog',
  'Changelog · Brigade',
  "What's new in Brigade, week by week.",
)

export default function Changelog() {
  return (
    <div className={c('page')}>
      <Header />
      <main>
        <section className={c('log')} aria-labelledby="log-title">
          <div className={c('wrap')}>
            <p className={c('eyebrow')}>Changelog</p>
            <h1 id="log-title">What&apos;s new in Brigade</h1>
            <p className={c('log-lead')}>
              Brigade ships every day. Each week, here is what changed.{' '}
              <a href={FEED_PATH}>RSS feed</a>
            </p>
            <ol className={c('log-list')}>
              {RELEASES.map((r) => (
                <li key={r.slug}>
                  <Link className={c('log-row')} href={`/changelog/${r.slug}`}>
                    <time dateTime={r.slug}>{releaseDate(r.slug)}</time>
                    <span className={c('log-body')}>
                      <span className={c('log-title')}>{r.title}</span>
                      <span className={c('log-sum')}>{r.summary}</span>
                      <span className={c('link')}>
                        See what&apos;s new
                        <Icon name="arrow" />
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ol>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  )
}
