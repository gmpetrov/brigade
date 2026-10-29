// The changelog as an RSS feed, one item per release, built with the site.
import { FEED_PATH, SITE } from '@/components/landing/changelog'
import { RELEASES } from '@/lib/changelog'

export const dynamic = 'force-static'
export const revalidate = false

const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const pubDate = (slug: string) => new Date(`${slug}T00:00:00Z`).toUTCString()

export function GET() {
  const items = RELEASES.map((r) => {
    const url = `${SITE}/changelog/${r.slug}`
    return `    <item>
      <title>${escape(r.title)}</title>
      <link>${url}</link>
      <guid isPermaLink="true">${url}</guid>
      <pubDate>${pubDate(r.slug)}</pubDate>
      <description>${escape(r.summary)}</description>
    </item>`
  }).join('\n')
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Brigade changelog</title>
    <link>${SITE}/changelog</link>
    <atom:link href="${SITE}${FEED_PATH}" rel="self" type="application/rss+xml" />
    <description>What's new in Brigade, week by week.</description>
    <language>en</language>
${RELEASES[0] ? `    <lastBuildDate>${pubDate(RELEASES[0].slug)}</lastBuildDate>\n` : ''}${items}
  </channel>
</rss>
`
  return new Response(xml, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } })
}
