// The site's public pages: the only ones its analytics may send from
// (components/landing/site-analytics.tsx), and the ones its sitemap lists (app/sitemap.ts).
// Never the sign-in pages, the dashboard or the demo.
export const PUBLIC_PAGES = [
  '/',
  '/privacy',
  '/terms',
  '/dpa',
  '/subprocessors',
  '/legal',
  '/changelog',
  '/compare',
] as const

const pages = new Set<string>(PUBLIC_PAGES)

// A release's page, /changelog/<day> (lib/changelog.ts), but not its feed.
const RELEASE_PAGE = /^\/changelog\/\d{4}-\d{2}-\d{2}$/
// A comparison's page, /compare/<slug> (lib/compare.ts).
const COMPARE_PAGE = /^\/compare\/[a-z0-9-]+$/

export const isPublicPage = (pathname: string) => {
  const path = pathname.replace(/\/+$/, '') || '/'
  return pages.has(path) || RELEASE_PAGE.test(path) || COMPARE_PAGE.test(path)
}
