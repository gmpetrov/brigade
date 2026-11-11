import type { MetadataRoute } from 'next'
import { OPERATOR } from '@/components/landing/operator'
import { RELEASES } from '@/lib/changelog'
import { COMPARISONS } from '@/lib/compare'
import { DOCS_PAGES, docsUrl } from '@/lib/docs-pages'
import { SITE_URL } from '@/lib/page-metadata'
import { PUBLIC_PAGES } from '@/lib/public-pages'

export const dynamic = 'force-static'

/** www.brigade.lol/sitemap.xml, as submitted to Search Console. */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    ...PUBLIC_PAGES
      // /legal is published only once the company exists (app/legal/page.tsx).
      .filter((path) => path !== '/legal' || OPERATOR.company)
      .map((path) => ({
        url: path === '/' ? `${SITE_URL}/` : `${SITE_URL}${path}`,
        priority: path === '/' ? 1 : path === '/compare' ? 0.7 : 0.3,
      })),
    // Each comparison (app/compare/[slug]).
    ...COMPARISONS.map((x) => ({ url: `${SITE_URL}/compare/${x.slug}`, priority: 0.7 })),
    // The docs, served from Mintlify under /docs (next.config.ts), whose own sitemap names
    // Mintlify's address instead.
    ...DOCS_PAGES.map((page) => ({ url: docsUrl(page), priority: 0.6 })),
    // Each release's page (app/changelog/[slug]), dated by its day.
    ...RELEASES.map((r) => ({
      url: `${SITE_URL}/changelog/${r.slug}`,
      lastModified: r.slug,
      priority: 0.3,
    })),
  ]
}
