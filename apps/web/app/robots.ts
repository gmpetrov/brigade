import type { MetadataRoute } from 'next'
import { SITE_URL } from '@/lib/page-metadata'

export const dynamic = 'force-static'

/** The dashboard, onboarding and invitations are behind a sign-in: nothing there for a crawler. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/', disallow: ['/app', '/onboarding', '/invite'] },
    sitemap: `${SITE_URL}/sitemap.xml`,
  }
}
