import Link from 'next/link'
import { SitePage } from '@/components/home/site-page'
import { c, Icon } from '@/components/landing/parts'
import { changelogMetadata, FEED_PATH } from '@/components/landing/changelog'
import { RELEASES, releaseDate } from '@/lib/changelog'

export const dynamic = 'force-static'
export const revalidate = false

export const metadata = changelogMetadata(
  '/changelog',
  'Changelog · Brigade',
  "What's new in Brigade, week by week: every release of the AI teammates app, what changed in it and the pull requests behind each change.",
)

export default function Changelog() {
  return (
    <SitePage>
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
                  <span className={c('log-when')}>
                    <time dateTime={r.slug}>{releaseDate(r.slug)}</time>
                    {r.version && <span className={c('log-ver')}>v{r.version}</span>}
                  </span>
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
    </SitePage>
  )
}
