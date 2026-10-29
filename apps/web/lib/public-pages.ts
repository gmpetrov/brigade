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
])

export const isPublicPage = (pathname: string) =>
  PUBLIC_PAGES.has(pathname.replace(/\/+$/, '') || '/')
