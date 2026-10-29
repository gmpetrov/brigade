// The site's public pages, the only ones its analytics may send from
// (components/landing/site-analytics.tsx): never the sign-in pages, the dashboard or the demo.
const PUBLIC_PAGES = new Set([
  '/',
  '/how-it-works',
  '/privacy',
  '/terms',
  '/dpa',
  '/subprocessors',
  '/legal',
  '/changelog',
])

export const isPublicPage = (pathname: string) => {
  const path = pathname.replace(/\/+$/, '') || '/'
  // A release's page, /changelog/<day>, but not the feed.
  return PUBLIC_PAGES.has(path) || /^\/changelog\/\d{4}-\d{2}-\d{2}$/.test(path)
}
