import type { MetadataRoute } from 'next'
import { OPERATOR } from '@/components/landing/operator'
import { SITE_URL } from '@/lib/page-metadata'
import { PUBLIC_PAGES } from '@/lib/public-pages'

export const dynamic = 'force-static'

/** www.brigade.lol/sitemap.xml, as submitted to Search Console. */
export default function sitemap(): MetadataRoute.Sitemap {
  return (
    PUBLIC_PAGES
      // /legal is published only once the company exists (app/legal/page.tsx).
      .filter((path) => path !== '/legal' || OPERATOR.company)
      .map((path) => ({
        url: path === '/' ? `${SITE_URL}/` : `${SITE_URL}${path}`,
        priority: path === '/' ? 1 : path === '/how-it-works' ? 0.8 : 0.3,
      }))
  )
}
